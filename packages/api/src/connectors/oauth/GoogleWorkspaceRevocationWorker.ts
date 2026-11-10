import {
  decryptConnectorCredential,
  type ConnectorCredentialEnvelope,
} from '../credentialCrypto';
import type { GoogleWorkspaceOAuthAdapter } from './GoogleWorkspaceOAuthAdapter';

export interface GoogleWorkspaceRevocationStore {
  claimGoogleWorkspaceRevocation(input: {
    leaseToken: string;
    leaseUntil: Date;
  }): Promise<{
    id: string;
    tenantId: string;
    installationId: string;
    provider: 'google-workspace';
    encryptedPayload: string;
    attempts: number;
    leaseToken: string;
  } | null>;
  isConnectorInstallationRevokedForSystem(input: {
    tenantId: string;
    installationId: string;
  }): Promise<boolean>;
  completeGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
  }): Promise<boolean>;
  retryGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
    nextAttemptAt: Date;
    errorCode: string;
    maxAttempts: number;
  }): Promise<'rescheduled' | 'dead' | 'lost'>;
}

export interface GoogleWorkspaceRevocationBatchResult {
  claimed: number;
  completed: number;
  rescheduled: number;
  dead: number;
  leaseLost: number;
}

function backoffMs(attempt: number): number {
  return Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.max(0, Math.min(attempt - 1, 10)));
}

/** Processes due remote revocations. Call inside explicit runAsSystem() context. */
export async function processGoogleWorkspaceRevocationBatch(input: {
  store: GoogleWorkspaceRevocationStore;
  adapter: Pick<GoogleWorkspaceOAuthAdapter, 'revokeToken'>;
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
  newLeaseToken?: () => string;
}): Promise<GoogleWorkspaceRevocationBatchResult> {
  const batchSize = input.batchSize ?? 10;
  const leaseMs = input.leaseMs ?? 60_000;
  const maxAttempts = input.maxAttempts ?? 12;
  const now = input.now ?? Date.now;
  const newLeaseToken = input.newLeaseToken ?? (() => {
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  });
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100 ||
      !Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000 ||
      !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error('Invalid Google Workspace revocation worker limits');
  }
  const result: GoogleWorkspaceRevocationBatchResult = {
    claimed: 0,
    completed: 0,
    rescheduled: 0,
    dead: 0,
    leaseLost: 0,
  };
  for (let index = 0; index < batchSize; index += 1) {
    const leaseToken = newLeaseToken();
    const job = await input.store.claimGoogleWorkspaceRevocation({
      leaseToken,
      leaseUntil: new Date(now() + leaseMs),
    });
    if (!job) break;
    result.claimed += 1;
    let errorCode = 'google_revocation_failed';
    try {
      const revoked = await input.store.isConnectorInstallationRevokedForSystem({
        tenantId: job.tenantId,
        installationId: job.installationId,
      });
      if (!revoked) {
        errorCode = 'installation_not_revoked';
        throw new Error('Installation is not locally revoked yet');
      }
      const envelope = JSON.parse(job.encryptedPayload) as ConnectorCredentialEnvelope;
      const plaintext = decryptConnectorCredential(envelope, {
        tenantId: job.tenantId,
        installationId: job.installationId,
        provider: job.provider,
      });
      const credentials = JSON.parse(plaintext) as Record<string, unknown>;
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        throw new Error('Invalid revocation credential payload');
      }
      const token =
        typeof credentials.refreshToken === 'string' && credentials.refreshToken.length > 0
          ? credentials.refreshToken
          : typeof credentials.accessToken === 'string'
            ? credentials.accessToken
            : '';
      if (token) await input.adapter.revokeToken({ token });
      const completed = await input.store.completeGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: job.leaseToken,
      });
      if (completed) result.completed += 1;
      else result.leaseLost += 1;
    } catch {
      const retry = await input.store.retryGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: job.leaseToken,
        nextAttemptAt: new Date(now() + backoffMs(job.attempts)),
        errorCode,
        maxAttempts,
      });
      if (retry === 'rescheduled') result.rescheduled += 1;
      else if (retry === 'dead') result.dead += 1;
      else result.leaseLost += 1;
    }
  }
  return result;
}
