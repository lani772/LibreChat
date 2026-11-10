import {
  decryptConnectorCredential,
  encryptConnectorCredential,
  type ConnectorCredentialEnvelope,
} from './credentialCrypto';

export interface ConnectorCredentialRotationStore {
  listConnectorCredentialsForRotation(input: {
    afterId?: string;
    limit: number;
  }): Promise<Array<{
    id: string;
    tenantId: string;
    installationId: string;
    provider: string;
    encryptedPayload: string;
    updatedAt: Date;
  }>>;
  replaceConnectorCredentialForRotation(input: {
    id: string;
    tenantId: string;
    expectedEncryptedPayload: string;
    expectedUpdatedAt: Date;
    encryptedPayload: string;
  }): Promise<boolean>;
}

export interface ConnectorCredentialRotationResult {
  dryRun: boolean;
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
  conflicts: number;
  failed: number;
  resumeAfterId?: string;
  complete: boolean;
}

/**
 * Bounded maintenance operation. Invoke only from an authenticated operator/maintenance
 * process inside runAsSystem(); the data-schemas methods independently enforce that context.
 */
export async function rotateConnectorCredentialEncryption(input: {
  store: ConnectorCredentialRotationStore;
  batchSize?: number;
  maxBatches?: number;
  afterId?: string;
  dryRun?: boolean;
}): Promise<ConnectorCredentialRotationResult> {
  const batchSize = input.batchSize ?? 50;
  const maxBatches = input.maxBatches ?? 10;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Credential rotation batch size must be between 1 and 100');
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error('Credential rotation maxBatches must be between 1 and 100');
  }
  const keyringRaw = process.env.CONNECTOR_CREDENTIALS_KEYRING?.trim();
  const activeKeyId = process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID?.trim();
  if (!keyringRaw || !activeKeyId) {
    throw new Error('Credential rotation requires an active versioned credential keyring');
  }
  let keyring: Record<string, unknown>;
  try {
    keyring = JSON.parse(keyringRaw) as Record<string, unknown>;
  } catch {
    throw new Error('Credential rotation keyring configuration is invalid');
  }
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring) ||
      typeof keyring[activeKeyId] !== 'string') {
    throw new Error('Credential rotation active key is unavailable');
  }

  const result: ConnectorCredentialRotationResult = {
    dryRun: input.dryRun === true,
    scanned: 0,
    migrated: 0,
    alreadyCurrent: 0,
    conflicts: 0,
    failed: 0,
    complete: false,
  };
  let cursor = input.afterId;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await input.store.listConnectorCredentialsForRotation({
      ...(cursor ? { afterId: cursor } : {}),
      limit: batchSize,
    });
    if (rows.length === 0) {
      result.complete = true;
      return result;
    }
    for (const row of rows) {
      result.scanned += 1;
      let envelope: ConnectorCredentialEnvelope;
      try {
        envelope = JSON.parse(row.encryptedPayload) as ConnectorCredentialEnvelope;
        if (!envelope || envelope.version !== 'gcm1') {
          throw new Error('Unsupported credential envelope');
        }
        if (envelope.keyId === activeKeyId) {
          result.alreadyCurrent += 1;
          cursor = row.id;
          result.resumeAfterId = cursor;
          continue;
        }
        const plaintext = decryptConnectorCredential(envelope, {
          tenantId: row.tenantId,
          installationId: row.installationId,
          provider: row.provider,
        });
        const rotated = encryptConnectorCredential(plaintext, {
          tenantId: row.tenantId,
          installationId: row.installationId,
          provider: row.provider,
        });
        if (rotated.keyId !== activeKeyId) {
          throw new Error('Credential encryption did not use the configured active key');
        }
        if (!input.dryRun) {
          const updated = await input.store.replaceConnectorCredentialForRotation({
            id: row.id,
            tenantId: row.tenantId,
            expectedEncryptedPayload: row.encryptedPayload,
            expectedUpdatedAt: row.updatedAt,
            encryptedPayload: JSON.stringify(rotated),
          });
          if (!updated) {
            result.conflicts += 1;
            cursor = row.id;
            result.resumeAfterId = cursor;
            continue;
          }
        }
        result.migrated += 1;
        cursor = row.id;
        result.resumeAfterId = cursor;
      } catch {
        // Stop at the first undecryptable row. Its ID is intentionally not returned;
        // operators can resume from the last successful cursor after correcting key config.
        result.failed += 1;
        result.complete = false;
        return result;
      }
    }
    if (rows.length < batchSize) {
      result.complete = true;
      return result;
    }
  }
  result.complete = false;
  return result;
}
