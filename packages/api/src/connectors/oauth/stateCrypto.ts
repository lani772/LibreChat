import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_ENV = 'CONNECTOR_OAUTH_STATE_KEY';
const VERSION = 'gcm1' as const;

interface OAuthStateVerifierEnvelope {
  version: typeof VERSION;
  nonce: string;
  tag: string;
  ciphertext: string;
}

function key(): Buffer {
  const value = process.env[KEY_ENV]?.trim();
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${KEY_ENV} must be configured as a 32-byte hexadecimal deployment secret`);
  }
  return Buffer.from(value, 'hex');
}

function aad(context: { stateHash: string; tenantId: string; principalId: string; installationId: string }): Buffer {
  return Buffer.from(JSON.stringify([
    'google-oauth-pkce-verifier',
    context.stateHash,
    context.tenantId,
    context.principalId,
    context.installationId,
  ]));
}

/** Encrypt PKCE verifier with a dedicated key and transaction-bound AAD. */
export function encryptGoogleOAuthVerifier(
  verifier: string,
  context: { stateHash: string; tenantId: string; principalId: string; installationId: string },
): string {
  if (!verifier || verifier.length > 256) throw new Error('Invalid Google OAuth PKCE verifier');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
  const envelope: OAuthStateVerifierEnvelope = {
    version: VERSION,
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
  return JSON.stringify(envelope);
}

export function decryptGoogleOAuthVerifier(
  serialized: string,
  context: { stateHash: string; tenantId: string; principalId: string; installationId: string },
): string {
  let envelope: OAuthStateVerifierEnvelope;
  try {
    envelope = JSON.parse(serialized) as OAuthStateVerifierEnvelope;
  } catch {
    throw new Error('Stored Google OAuth verifier is invalid');
  }
  if (
    envelope.version !== VERSION ||
    !/^[a-f0-9]{24}$/i.test(envelope.nonce) ||
    !/^[a-f0-9]{32}$/i.test(envelope.tag) ||
    !/^(?:[a-f0-9]{2})+$/i.test(envelope.ciphertext)
  ) {
    throw new Error('Stored Google OAuth verifier envelope is invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(envelope.nonce, 'hex'));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}
