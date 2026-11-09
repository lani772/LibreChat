import type {
  ConnectorCredentialCiphertext,
  ConnectorCredentialSummary,
} from '@librechat/data-schemas';
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
  }): Promise<ConnectorCredentialSummary>;
  getConnectorCredentialCiphertext(
    installationId: string,
  ): Promise<ConnectorCredentialCiphertext | null>;
  deleteConnectorCredential(installationId: string): Promise<{ deleted: boolean }>;
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
  ) {}

  async storeCredentials(
    installationId: string,
    provider: string,
    values: ConnectorCredentialValues,
  ): Promise<ConnectorCredentialSummary> {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('Connector credentials must be a JSON object');
    }
    const json = JSON.stringify(values);
    if (!json || Buffer.byteLength(json, 'utf8') > 64 * 1024) {
      throw new Error('Connector credential payload exceeds the 64 KiB limit');
    }
    const authorized = await this.connectors.authorize(installationId);
    if (authorized.installation.provider !== provider.toLowerCase()) {
      throw new Error('Connector provider does not match its installation');
    }
    const envelope = encryptConnectorCredential(json, {
      tenantId: authorized.tenantId,
      installationId,
      provider,
    });
    return this.store.putConnectorCredential({
      installationId,
      provider: provider.toLowerCase(),
      encryptedPayload: JSON.stringify(envelope),
      keyVersion: envelope.version,
    });
  }

  async withCredentials<TResult>(
    installationId: string,
    operation: (credentials: ConnectorCredentialValues) => Promise<TResult>,
  ): Promise<TResult> {
    return this.connectors.execute(installationId, async (authorized) => {
      const stored = await this.store.getConnectorCredentialCiphertext(installationId);
      if (!stored || stored.provider !== authorized.installation.provider) {
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

  async deleteCredentials(installationId: string): Promise<{ deleted: boolean }> {
    return this.store.deleteConnectorCredential(installationId);
  }
}
