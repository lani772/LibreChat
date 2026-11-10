import {
  decryptConnectorCredential,
  encryptConnectorCredential,
  type ConnectorCredentialEnvelope,
} from './credentialCrypto';

export interface ConnectorCredentialRotationRecord {
  id: string;
  tenantId: string;
  installationId: string;
  provider: string;
  encryptedPayload: string;
  updatedAt: Date;
}

export interface ConnectorCredentialRotationStore {
  listConnectorCredentialsForRotation(input: { afterId?: string; limit: number }): Promise<ConnectorCredentialRotationRecord[]>;
  replaceConnectorCredentialForRotation(input: {
    id: string; tenantId: string; expectedEncryptedPayload: string;
    expectedUpdatedAt: Date; encryptedPayload: string;
  }): Promise<boolean>;
  listConnectorRevocationsForRotation(input: { afterId?: string; limit: number }): Promise<ConnectorCredentialRotationRecord[]>;
  replaceConnectorRevocationForRotation(input: {
    id: string; tenantId: string; expectedEncryptedPayload: string;
    expectedUpdatedAt: Date; encryptedPayload: string;
  }): Promise<boolean>;
}

export interface ConnectorCredentialRotationResult {
  dryRun: boolean;
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
  conflicts: number;
  failed: number;
  revocationsScanned: number;
  revocationsMigrated: number;
  revocationsAlreadyCurrent: number;
  revocationConflicts: number;
  revocationFailed: number;
  resumeAfterId?: string;
  resumeAfterRevocationId?: string;
  complete: boolean;
}

interface CollectionRotationResult {
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
  conflicts: number;
  failed: number;
  resumeAfterId?: string;
  complete: boolean;
}

async function rotateCollection(input: {
  list: (cursor: string | undefined, limit: number) => Promise<ConnectorCredentialRotationRecord[]>;
  replace: (record: ConnectorCredentialRotationRecord, encryptedPayload: string) => Promise<boolean>;
  afterId?: string;
  batchSize: number;
  maxBatches: number;
  activeKeyId: string;
  dryRun: boolean;
}): Promise<CollectionRotationResult> {
  const result: CollectionRotationResult = {
    scanned: 0, migrated: 0, alreadyCurrent: 0, conflicts: 0, failed: 0, complete: false,
  };
  let cursor = input.afterId;
  for (let batch = 0; batch < input.maxBatches; batch += 1) {
    const rows = await input.list(cursor, input.batchSize);
    if (rows.length === 0) {
      result.complete = true;
      return result;
    }
    for (const row of rows) {
      result.scanned += 1;
      try {
        const envelope = JSON.parse(row.encryptedPayload) as ConnectorCredentialEnvelope;
        if (!envelope || envelope.version !== 'gcm1') throw new Error('Unsupported credential envelope');
        if (envelope.keyId === input.activeKeyId) {
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
        if (rotated.keyId !== input.activeKeyId) {
          throw new Error('Credential encryption did not use the configured active key');
        }
        if (!input.dryRun) {
          const updated = await input.replace(row, JSON.stringify(rotated));
          if (!updated) result.conflicts += 1;
          else result.migrated += 1;
        } else {
          result.migrated += 1;
        }
        cursor = row.id;
        result.resumeAfterId = cursor;
      } catch {
        result.failed += 1;
        result.complete = false;
        return result;
      }
    }
    if (rows.length < input.batchSize) {
      result.complete = true;
      return result;
    }
  }
  return result;
}

/**
 * Rotates both live connector credentials and encrypted revocation-outbox payloads.
 * Invoke only from an operator maintenance process inside runAsSystem(); both data stores
 * independently enforce that context. The two collections have independent resume cursors.
 */
export async function rotateConnectorCredentialEncryption(input: {
  store: ConnectorCredentialRotationStore;
  batchSize?: number;
  maxBatches?: number;
  afterId?: string;
  afterRevocationId?: string;
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
      typeof keyring[activeKeyId] !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(keyring[activeKeyId] as string)) {
    throw new Error('Credential rotation active key is unavailable');
  }
  const keyProbe = encryptConnectorCredential('', {
    tenantId: '__credential_rotation_validation__',
    installationId: '000000000000000000000000',
    provider: 'google-workspace',
  });
  if (keyProbe.keyId !== activeKeyId) {
    throw new Error('Credential rotation active key is not selected for encryption');
  }

  const credentials = await rotateCollection({
    list: (cursor, limit) => input.store.listConnectorCredentialsForRotation({
      ...(cursor ? { afterId: cursor } : {}), limit,
    }),
    replace: (row, encryptedPayload) => input.store.replaceConnectorCredentialForRotation({
      id: row.id,
      tenantId: row.tenantId,
      expectedEncryptedPayload: row.encryptedPayload,
      expectedUpdatedAt: row.updatedAt,
      encryptedPayload,
    }),
    afterId: input.afterId,
    batchSize,
    maxBatches,
    activeKeyId,
    dryRun: input.dryRun === true,
  });
  const revocations = await rotateCollection({
    list: (cursor, limit) => input.store.listConnectorRevocationsForRotation({
      ...(cursor ? { afterId: cursor } : {}), limit,
    }),
    replace: (row, encryptedPayload) => input.store.replaceConnectorRevocationForRotation({
      id: row.id,
      tenantId: row.tenantId,
      expectedEncryptedPayload: row.encryptedPayload,
      expectedUpdatedAt: row.updatedAt,
      encryptedPayload,
    }),
    afterId: input.afterRevocationId,
    batchSize,
    maxBatches,
    activeKeyId,
    dryRun: input.dryRun === true,
  });
  return {
    dryRun: input.dryRun === true,
    scanned: credentials.scanned,
    migrated: credentials.migrated,
    alreadyCurrent: credentials.alreadyCurrent,
    conflicts: credentials.conflicts,
    failed: credentials.failed,
    revocationsScanned: revocations.scanned,
    revocationsMigrated: revocations.migrated,
    revocationsAlreadyCurrent: revocations.alreadyCurrent,
    revocationConflicts: revocations.conflicts,
    revocationFailed: revocations.failed,
    ...(credentials.resumeAfterId ? { resumeAfterId: credentials.resumeAfterId } : {}),
    ...(revocations.resumeAfterId ? { resumeAfterRevocationId: revocations.resumeAfterId } : {}),
    complete: credentials.complete && revocations.complete,
  };
}
