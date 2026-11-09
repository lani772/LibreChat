import { randomUUID } from 'node:crypto';
import type { ConnectorCredentialVault, ConnectorCredentialValues } from '../ConnectorCredentialVault';
import { GoogleWorkspaceOAuthError, type GoogleWorkspaceOAuthAdapter } from './GoogleWorkspaceOAuthAdapter';

const ACCESS_TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000;
const REFRESH_LEASE_MS = 30_000;
const REFRESH_WAIT_MS = 250;
const REFRESH_ATTEMPTS = 60;

class RefreshLeaseBusyError extends Error {
  constructor() {
    super('Google Workspace token refresh is already in progress');
    this.name = 'RefreshLeaseBusyError';
  }
}

function requiredCredential(credentials: ConnectorCredentialValues, key: string): string {
  const value = credentials[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Google Workspace credentials require reconnection');
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GoogleWorkspaceTokenLifecycleDependencies {
  adapter: Pick<GoogleWorkspaceOAuthAdapter, 'refreshAccessToken' | 'revokeToken'>;
  vault: Pick<
    ConnectorCredentialVault,
    'withCredentials' | 'storeCredentials' | 'claimRefreshLease' | 'releaseRefreshLease'
  >;
  installations: {
    getConnectorInstallation(id: string): Promise<{
      _id: { toString(): string };
      provider: string;
      state: string;
      version: number;
    } | null>;
    transitionConnectorInstallation(input: {
      installationId: string;
      expectedVersion: number;
      state: 'error';
      lastErrorCode: string;
    }): Promise<unknown>;
    revokeConnectorInstallation(id: string): Promise<boolean>;
  };
  now?: () => number;
  newLeaseToken?: () => string;
}

/**
 * Coordinates refreshes with a MongoDB compare-and-set lease, so multiple
 * LibreChat processes cannot normally refresh and overwrite the same token pair.
 * The lease token is also required by the credential write, fencing stale holders.
 */
export class GoogleWorkspaceTokenLifecycle {
  private readonly now: () => number;
  private readonly newLeaseToken: () => string;

  constructor(private readonly deps: GoogleWorkspaceTokenLifecycleDependencies) {
    this.now = deps.now ?? Date.now;
    this.newLeaseToken = deps.newLeaseToken ?? randomUUID;
  }

  async getAccessToken(installationId: string): Promise<string> {
    for (let attempt = 0; attempt < REFRESH_ATTEMPTS; attempt += 1) {
      try {
        return await this.deps.vault.withCredentials(installationId, async (credentials) => {
          const accessToken = requiredCredential(credentials, 'accessToken');
          const expiresAt = Number(credentials.expiresAt);
          if (Number.isFinite(expiresAt) && expiresAt > this.now() + ACCESS_TOKEN_REFRESH_SKEW_MS) {
            return accessToken;
          }

          const refreshToken = requiredCredential(credentials, 'refreshToken');
          const leaseToken = this.newLeaseToken();
          const claimed = await this.deps.vault.claimRefreshLease(
            installationId,
            leaseToken,
            REFRESH_LEASE_MS,
          );
          if (!claimed) throw new RefreshLeaseBusyError();

          try {
            // Re-read inside a fresh authorized vault operation after acquiring the
            // distributed lease. The original snapshot may predate another process's refresh.
            return this.deps.vault.withCredentials(installationId, async (latestCredentials) => {
              const latestAccess = requiredCredential(latestCredentials, 'accessToken');
              const latestExpiry = Number(latestCredentials.expiresAt);
              if (
                Number.isFinite(latestExpiry) &&
                latestExpiry > this.now() + ACCESS_TOKEN_REFRESH_SKEW_MS
              ) {
                return latestAccess;
              }
              const latestRefreshToken = requiredCredential(latestCredentials, 'refreshToken');
              const refreshed = await this.deps.adapter.refreshAccessToken({
                refreshToken: latestRefreshToken,
              });
              const nextRefreshToken = refreshed.refreshToken || latestRefreshToken;
              await this.deps.vault.storeCredentials(
                installationId,
                'google-workspace',
                {
                  ...latestCredentials,
                  accessToken: refreshed.accessToken,
                  refreshToken: nextRefreshToken,
                  expiresAt: refreshed.expiresAt,
                  scopes: refreshed.scopes.length > 0 ? refreshed.scopes : latestCredentials.scopes,
                  tokenType: refreshed.tokenType,
                },
                { refreshLeaseToken: leaseToken },
              );
              return refreshed.accessToken;
            });
          } finally {
            await this.deps.vault.releaseRefreshLease(installationId, leaseToken).catch(() => false);
          }
        });
      } catch (error) {
        if (!(error instanceof RefreshLeaseBusyError)) {
          const message = error instanceof Error ? error.message : '';
          if (
            (error instanceof GoogleWorkspaceOAuthError && error.code === 'invalid_grant') ||
            /credentials require reconnection/i.test(message)
          ) {
            await this.markReauthorizationRequired(installationId);
          }
          throw error;
        }
        await sleep(REFRESH_WAIT_MS);
      }
    }
    throw new Error('Google Workspace token refresh did not complete; retry the request');
  }

  private async markReauthorizationRequired(installationId: string): Promise<void> {
    const current = await this.deps.installations.getConnectorInstallation(installationId).catch(() => null);
    if (!current || current.state === 'revoked' || current.state === 'error') return;
    await this.deps.installations.transitionConnectorInstallation({
      installationId,
      expectedVersion: current.version,
      state: 'error',
      lastErrorCode: 'google_reauthorization_required',
    }).catch(() => undefined);
  }

  /**
   * Always revoke locally, even if Google's endpoint is unavailable. The result
   * reports remote revocation failure so the UI/operator can distinguish it.
   */
  async disconnect(installationId: string): Promise<{
    disconnected: boolean;
    remoteRevocation: 'confirmed' | 'pending' | 'not_attempted';
  }> {
    let remoteRevocation: 'confirmed' | 'pending' | 'not_attempted' = 'not_attempted';
    try {
      await this.deps.vault.withCredentials(installationId, async (credentials) => {
        const token =
          typeof credentials.refreshToken === 'string' && credentials.refreshToken.length > 0
            ? credentials.refreshToken
            : typeof credentials.accessToken === 'string'
              ? credentials.accessToken
              : '';
        if (!token) return;
        try {
          await this.deps.adapter.revokeToken({ token });
          remoteRevocation = 'confirmed';
        } catch {
          remoteRevocation = 'pending';
        }
      });
    } catch {
      // Local revocation must still proceed if credentials are missing or already inaccessible.
      remoteRevocation = 'not_attempted';
    }

    const disconnected = await this.deps.installations.revokeConnectorInstallation(installationId);
    return { disconnected, remoteRevocation };
  }
}
