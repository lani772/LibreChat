import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_ENV = 'CONNECTOR_CREDENTIALS_KEY';
const MAX_PLAINTEXT_BYTES = 64 * 1024;

export interface ConnectorCredentialEnvelope {
  version: 'gcm1';
  nonce: string;
  tag: string;
  ciphertext: string;
}

function getKey(): Buffer {
  const value = process.env[KEY_ENV]?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${KEY_ENV} must be configured as a 32-byte hexadecimal key in the deployment secret manager`);
  }
  return Buffer.from(value, 'hex');
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

/** Authenticated encryption; context is bound as AAD to prevent cross-tenant/installation swaps. */
export function encryptConnectorCredential(
  plaintext: string,
  context: { tenantId: string; installationId: string; provider: string },
): ConnectorCredentialEnvelope {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new Error('Connector credential payload exceeds the 64 KiB limit');
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), nonce);
  cipher.setAAD(getAAD(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    version: 'gcm1',
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/** Authentication failure is fatal; no plaintext or legacy-cipher fallback is attempted. */
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
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(envelope.nonce, 'hex'));
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
