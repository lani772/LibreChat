import { createHash, randomBytes } from 'node:crypto';
import type { ConnectorCredentialVault } from '../ConnectorCredentialVault';
import type { ConnectorOAuthAdapter } from './types';

const GOOGLE_AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export interface GoogleOAuthIdentity {
  tenantId: string;
  principalId: string;
}

export interface GoogleOAuthPendingState {
  stateHash: string;
  tenantId: string;
  principalId: string;
  installationId: string;
  redirectUri: string;
  codeVerifier: string;
  expiresAt: Date;
}

export interface GoogleOAuthInstallation {
  _id: { toString(): string };
  tenantId?: string;
  ownerUserId: string;
  provider: string;
  state: string;
  version: number;
}

export interface GoogleWorkspaceOAuthFlowDependencies {
  adapter: ConnectorOAuthAdapter;
  vault: Pick<ConnectorCredentialVault, 'storeCredentials'>;
  installations: {
    getConnectorInstallation(id: string): Promise<GoogleOAuthInstallation | null>;
    transitionConnectorInstallation(input: {
      installationId: string;
      expectedVersion: number;
      state: 'authorizing' | 'connected' | 'error';
      lastErrorCode?: string;
    }): Promise<unknown>;
  };
  states: {
    /** Must enforce unique stateHash. Store only a hash, never the raw state. */
    create(input: GoogleOAuthPendingState): Promise<void>;
    /** Must atomically consume and delete a state record; concurrent callbacks get one winner. */
    consume(stateHash: string): Promise<GoogleOAuthPendingState | null>;
  };
  /** Re-establishes the trusted tenant/principal AsyncLocalStorage context captured at start. */
  runWithIdentity<TResult>(identity: GoogleOAuthIdentity, operation: () => Promise<TResult>): Promise<TResult>;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export class GoogleWorkspaceOAuthFlow {
  private readonly now: () => number;
  private readonly random: (size: number) => Buffer;

  constructor(private readonly deps: GoogleWorkspaceOAuthFlowDependencies) {
    if (deps.adapter.provider !== 'google-workspace') {
      throw new Error('Google Workspace OAuth adapter is required');
    }
    if (!deps.clientId.trim() || !deps.redirectUri.trim() || deps.scopes.length === 0) {
      throw new Error('Google OAuth client, callback URI, and scopes are required');
    }
    const callback = new URL(deps.redirectUri);
    if (callback.protocol !== 'https:' && callback.hostname !== 'localhost') {
      throw new Error('Google OAuth callback must use HTTPS');
    }
    this.now = deps.now ?? Date.now;
    this.random = deps.randomBytes ?? randomBytes;
  }

  async begin(input: { identity: GoogleOAuthIdentity; installationId: string }): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    const { identity, installationId } = input;
    if (!identity.tenantId || !identity.principalId || identity.tenantId === '__SYSTEM__') {
      throw new Error('Trusted tenant and user identity are required');
    }
    const installation = await this.deps.installations.getConnectorInstallation(installationId);
    if (
      !installation ||
      installation.tenantId !== identity.tenantId ||
      installation.ownerUserId !== identity.principalId ||
      installation.provider !== 'google-workspace' ||
      installation.state === 'revoked'
    ) {
      throw new Error('Google Workspace connector installation is unavailable');
    }
    const state = this.random(32).toString('base64url');
    const verifier = this.random(48).toString('base64url');
    const challenge = sha256(verifier);
    const expiresAt = new Date(this.now() + STATE_TTL_MS);
    const stateHash = sha256(state);
    await this.deps.states.create({
      stateHash,
      tenantId: identity.tenantId,
      principalId: identity.principalId,
      installationId,
      redirectUri: this.deps.redirectUri,
      codeVerifier: verifier,
      expiresAt,
    });
    const transition = await this.deps.installations.transitionConnectorInstallation({
      installationId,
      expectedVersion: installation.version,
      state: 'authorizing',
    });
    if (!transition) {
      throw new Error('Google Workspace connector changed; restart authorization');
    }
    const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT);
    url.search = new URLSearchParams({
      client_id: this.deps.clientId,
      redirect_uri: this.deps.redirectUri,
      response_type: 'code',
      scope: this.deps.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.toString(), expiresAt };
  }

  /** Consume a provider-denied/cancelled callback so its transaction cannot be replayed. */
  async cancel(input: { state: string }): Promise<boolean> {
    if (!STATE_PATTERN.test(input.state)) return false;
    const pending = await this.deps.states.consume(sha256(input.state));
    if (!pending || pending.expiresAt.getTime() <= this.now()) return false;
    const identity = { tenantId: pending.tenantId, principalId: pending.principalId };
    await this.deps.runWithIdentity(identity, async () => {
      const installation = await this.deps.installations.getConnectorInstallation(pending.installationId);
      if (installation && installation.state !== 'revoked' && installation.state !== 'connected') {
        await this.deps.installations.transitionConnectorInstallation({
          installationId: pending.installationId,
          expectedVersion: installation.version,
          state: 'error',
          lastErrorCode: 'oauth_user_cancelled',
        });
      }
    });
    return true;
  }

  async complete(input: { state: string; code: string }): Promise<{ installationId: string; connected: true }> {
    if (!STATE_PATTERN.test(input.state) || !input.code?.trim() || input.code.length > 4096) {
      throw new Error('Invalid Google OAuth callback');
    }
    const pending = await this.deps.states.consume(sha256(input.state));
    if (!pending || pending.expiresAt.getTime() <= this.now()) {
      throw new Error('Google OAuth state is invalid, expired, or already used');
    }
    const identity = { tenantId: pending.tenantId, principalId: pending.principalId };
    try {
      return await this.deps.runWithIdentity(identity, async () => {
        const installation = await this.deps.installations.getConnectorInstallation(pending.installationId);
        if (
          !installation ||
          installation.tenantId !== pending.tenantId ||
          installation.ownerUserId !== pending.principalId ||
          installation.provider !== 'google-workspace' ||
          installation.state === 'revoked'
        ) {
          throw new Error('Google Workspace connector installation is unavailable');
        }
        const tokens = await this.deps.adapter.exchangeAuthorizationCode({
          code: input.code,
          redirectUri: pending.redirectUri,
          codeVerifier: pending.codeVerifier,
        });
        await this.deps.vault.storeCredentials(pending.installationId, 'google-workspace', {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          tokenType: tokens.tokenType,
        });
        const connected = await this.deps.installations.transitionConnectorInstallation({
          installationId: pending.installationId,
          expectedVersion: installation.version,
          state: 'connected',
        });
        if (!connected) {
          throw new Error('Google Workspace connector changed during authorization; reconnect');
        }
        return { installationId: pending.installationId, connected: true as const };
      });
    } catch (error) {
      await this.deps.runWithIdentity(identity, async () => {
        const current = await this.deps.installations.getConnectorInstallation(pending.installationId);
        if (current && current.state !== 'revoked' && current.state !== 'connected') {
          await this.deps.installations.transitionConnectorInstallation({
            installationId: pending.installationId,
            expectedVersion: current.version,
            state: 'error',
            lastErrorCode: 'oauth_callback_failed',
          });
        }
      }).catch(() => undefined);
      throw error;
    }
  }
}
