import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV = 'CONNECTOR_CREDENTIALS_KEY';
const KEYRING_ENV = 'CONNECTOR_CREDENTIALS_KEYRING';
const ACTIVE_KEY_ID_ENV = 'CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID';
const MAX_PLAINTEXT_BYTES = 64 * 1024;

export interface ConnectorCredentialEnvelope {
  version: 'gcm1';
  /** Absent only on legacy envelopes encrypted with CONNECTOR_CREDENTIALS_KEY. */
  keyId?: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

type KeyMaterial = { key: Buffer; keyId?: string };

function parseHexKey(value: unknown, setting: string): Buffer {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value.trim())) {
    throw new Error(`${setting} must contain a 32-byte hexadecimal key`);
  }
  return Buffer.from(value.trim(), 'hex');
}

function getKeyring(): Record<string, Buffer> {
  const raw = process.env[KEYRING_ENV]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${KEYRING_ENV} must be a JSON object mapping key IDs to 32-byte hexadecimal keys`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${KEYRING_ENV} must be a JSON object mapping key IDs to 32-byte hexadecimal keys`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 20) {
    throw new Error(`${KEYRING_ENV} must contain between 1 and 20 keys`);
  }
  const keys: Record<string, Buffer> = {};
  for (const [keyId, value] of entries) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) {
      throw new Error(`${KEYRING_ENV} contains an invalid key ID`);
    }
    keys[keyId] = parseHexKey(value, `${KEYRING_ENV}[${keyId}]`);
  }
  return keys;
}

function getEncryptionKey(): KeyMaterial {
  const rawKeyring = process.env[KEYRING_ENV]?.trim();
  if (rawKeyring) {
    const keyring = getKeyring();
    const activeKeyId = process.env[ACTIVE_KEY_ID_ENV]?.trim();
    if (!activeKeyId || !keyring[activeKeyId]) {
      throw new Error(`${ACTIVE_KEY_ID_ENV} must identify a key in ${KEYRING_ENV}`);
    }
    return { key: keyring[activeKeyId], keyId: activeKeyId };
  }

  const legacyKey = process.env[KEY_ENV]?.trim();
  if (!legacyKey || !/^[a-f0-9]{64}$/i.test(legacyKey)) {
    throw new Error(
      `${KEY_ENV} must be configured as a 32-byte hexadecimal key in the deployment secret manager`,
    );
  }
  return { key: Buffer.from(legacyKey, 'hex') };
}

function getDecryptionKey(envelope: ConnectorCredentialEnvelope): Buffer {
  if (envelope.keyId !== undefined) {
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(envelope.keyId)) {
      throw new Error('Invalid connector credential key ID');
    }
    const key = getKeyring()[envelope.keyId];
    if (!key) throw new Error('Connector credential encryption key is unavailable');
    return key;
  }
  // Backward compatibility for existing gcm1 envelopes without a key ID.
  const legacyKey = process.env[KEY_ENV]?.trim();
  if (!legacyKey || !/^[a-f0-9]{64}$/i.test(legacyKey)) {
    throw new Error(`Legacy connector credentials require ${KEY_ENV} until they are re-encrypted`);
  }
  return Buffer.from(legacyKey, 'hex');
}

function getAAD(context: { tenantId: string; installationId: string; provider: string }): Buffer {
  if (!context.tenantId || !context.installationId || !context.provider) {
    throw new Error('Connector credential encryption context is incomplete');
  }
  return Buffer.from(
    JSON.stringify([context.tenantId, context.installationId, context.provider.toLowerCase()]),
    'utf8',
  );
}

/** AES-256-GCM encryption; tenant, installation, and provider are bound as authenticated data. */
export function encryptConnectorCredential(
  plaintext: string,
  context: { tenantId: string; installationId: string; provider: string },
): ConnectorCredentialEnvelope {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new Error('Connector credential payload exceeds the 64 KiB limit');
  }
  const { key, keyId } = getEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(getAAD(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 'gcm1',
    ...(keyId ? { keyId } : {}),
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Unknown key IDs and authentication failures are fatal; no plaintext fallback is attempted. */
export function decryptConnectorCredential(
  envelope: ConnectorCredentialEnvelope,
  context: { tenantId: string; installationId: string; provider: string },
): string {
  if (
    envelope.version !== 'gcm1' ||
    !/^[a-f0-9]{24}$/i.test(envelope.nonce) ||
    !/^[a-f0-9]{32}$/i.test(envelope.tag) ||
    !/^(?:[a-f0-9]{2})*$/i.test(envelope.ciphertext)
  ) {
    throw new Error('Invalid connector credential envelope');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    getDecryptionKey(envelope),
    Buffer.from(envelope.nonce, 'hex'),
  );
  decipher.setAAD(getAAD(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new Error('Decrypted connector credential payload exceeds the size limit');
  }
  return plaintext;
}
