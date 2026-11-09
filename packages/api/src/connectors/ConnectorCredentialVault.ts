import type {
  ConnectorCredentialCiphertext,
  ConnectorCredentialSummary,
} from '@librechat/data-schemas';
import { getTenantId } from '@librechat/data-schemas';
import type { ConnectorService } from './ConnectorService';
import {
  decryptConnectorCredential,
  encryptConnectorCredential,
  type ConnectorCredentialEnvelope,
} from './credentialCrypto';

export interface ConnectorCredentialStore {
  putConnectorCredential(input: {
    installationId: string;
    provider: string;
    encryptedPayload: string;
    keyVersion: 'gcm1';
    refreshLeaseToken?: string;
  }): Promise<ConnectorCredentialSummary>;
  getConnectorCredentialCiphertext(
    installationId: string,
  ): Promise<ConnectorCredentialCiphertext | null>;
  deleteConnectorCredential(installationId: string): Promise<{ deleted: boolean }>;
  claimConnectorCredentialRefresh(input: { installationId: string; leaseToken: string; leaseUntil: Date }): Promise<boolean>;
  releaseConnectorCredentialRefresh(input: { installationId: string; leaseToken: string }): Promise<boolean>;
}

export type ConnectorCredentialValues = Record<string, unknown>;

/**
 * The only application service allowed to turn connector credential ciphertext
 * into plaintext. Reads are nested inside ConnectorService authorization so
 * an unauthorized caller cannot trigger vault access or decryption.
 */
export class ConnectorCredentialVault {
  constructor(
    private readonly store: ConnectorCredentialStore,
    private readonly connectors: ConnectorService,
    private readonly getTenantIdFromContext: () => string | undefined = getTenantId,
  ) {}

  async storeCredentials(
    installationId: string,
    provider: string,
    values: ConnectorCredentialValues,
    options: { refreshLeaseToken?: string } = {},
  ): Promise<ConnectorCredentialSummary> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Connector credentials must be a JSON object');
    }
    const json = JSON.stringify(values);
    if (!json || Buffer.byteLength(json, 'utf8') > 64 * 1024) {
      throw new Error('Connector credential payload exceeds the 64 KiB limit');
    }
    const tenantId = this.getTenantIdFromContext();
    if (!tenantId || tenantId === '__SYSTEM__') {
      throw new Error('Connector credential storage requires an active tenant context');
    }
    const envelope = encryptConnectorCredential(json, {
      tenantId,
      installationId,
      provider,
    });
    return this.store.putConnectorCredential({
      installationId,
      provider: provider.toLowerCase(),
      encryptedPayload: JSON.stringify(envelope),
      keyVersion: envelope.version,
      ...(options.refreshLeaseToken ? { refreshLeaseToken: options.refreshLeaseToken } : {}),
    });
  }

  async withCredentials<TResult>(
    installationId: string,
    operation: (credentials: ConnectorCredentialValues) => Promise<TResult>,
  ): Promise<TResult> {
    return this.connectors.execute(installationId, async (authorized) => {
      const stored = await this.store.getConnectorCredentialCiphertext(installationId);
      if (
        !stored ||
        stored.tenantId !== authorized.tenantId ||
        stored.installationId !== installationId ||
        stored.provider !== authorized.installation.provider ||
        stored.keyVersion !== 'gcm1'
      ) {
        throw new Error('Connector credentials are unavailable');
      }
      const envelope = JSON.parse(stored.encryptedPayload) as ConnectorCredentialEnvelope;
      const plaintext = decryptConnectorCredential(envelope, {
        tenantId: authorized.tenantId,
        installationId,
        provider: authorized.installation.provider,
      });
      let credentials: unknown;
      try {
        credentials = JSON.parse(plaintext);
      } catch {
        throw new Error('Stored connector credential payload is invalid');
      }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        throw new Error('Stored connector credential payload is invalid');
      }
      return operation(credentials as ConnectorCredentialValues);
    });
  }

  async claimRefreshLease(installationId: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 120_000) {
      throw new Error('Invalid connector credential refresh lease duration');
    }
    return this.store.claimConnectorCredentialRefresh({
      installationId,
      leaseToken,
      leaseUntil: new Date(Date.now() + leaseMs),
    });
  }

  async releaseRefreshLease(installationId: string, leaseToken: string): Promise<boolean> {
    return this.store.releaseConnectorCredentialRefresh({ installationId, leaseToken });
  }

  async deleteCredentials(installationId: string): Promise<{ deleted: boolean }> {
    return this.store.deleteConnectorCredential(installationId);
  }
}
