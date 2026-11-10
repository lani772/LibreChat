import {
  decryptConnectorCredential,
  encryptConnectorCredential,
} from './credentialCrypto';

describe('connector credential authenticated encryption', () => {
  const originalKey = process.env.CONNECTOR_CREDENTIALS_KEY;
  const originalKeyring = process.env.CONNECTOR_CREDENTIALS_KEYRING;
  const originalActiveKeyId = process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
  const context = {
    tenantId: 'tenant-a',
    installationId: '64b000000000000000000001',
    provider: 'chatwoot',
  };

  beforeEach(() => {
    process.env.CONNECTOR_CREDENTIALS_KEY = '11'.repeat(32);
    delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
    delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEY;
    else process.env.CONNECTOR_CREDENTIALS_KEY = originalKey;
    if (originalKeyring === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    else process.env.CONNECTOR_CREDENTIALS_KEYRING = originalKeyring;
    if (originalActiveKeyId === undefined) delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
    else process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = originalActiveKeyId;
  });

  it('round-trips a credential object and never stores plaintext in the envelope', () => {
    const plaintext = JSON.stringify({ accessToken: 'very-secret-token' });
    const envelope = encryptConnectorCredential(plaintext, context);
    expect(JSON.stringify(envelope)).not.toContain('very-secret-token');
    expect(decryptConnectorCredential(envelope, context)).toBe(plaintext);
  });

  it('rejects tampered ciphertext and authentication tags', () => {
    const envelope = encryptConnectorCredential('secret', context);
    expect(() =>
      decryptConnectorCredential(
        { ...envelope, ciphertext: envelope.ciphertext.slice(0, -2) + '00' },
        context,
      ),
    ).toThrow();
    expect(() =>
      decryptConnectorCredential({ ...envelope, tag: '00'.repeat(16) }, context),
    ).toThrow();
  });

  it('binds ciphertext to tenant, installation, and provider using authenticated metadata', () => {
    const envelope = encryptConnectorCredential('secret', context);
    expect(() =>
      decryptConnectorCredential(envelope, { ...context, tenantId: 'tenant-b' }),
    ).toThrow();
    expect(() =>
      decryptConnectorCredential(envelope, {
        ...context,
        installationId: '64b000000000000000000002',
      }),
    ).toThrow();
    expect(() =>
      decryptConnectorCredential(envelope, { ...context, provider: 'google-workspace' }),
    ).toThrow();
  });

  it('refuses to encrypt when the dedicated key is missing or malformed', () => {
    delete process.env.CONNECTOR_CREDENTIALS_KEY;
    expect(() => encryptConnectorCredential('secret', context)).toThrow(
      'CONNECTOR_CREDENTIALS_KEY',
    );
    process.env.CONNECTOR_CREDENTIALS_KEY = 'too-short';
    expect(() => encryptConnectorCredential('secret', context)).toThrow(
      'CONNECTOR_CREDENTIALS_KEY',
    );
  });


  it('encrypts with the configured active key ID and decrypts with a retained previous key', () => {
    process.env.CONNECTOR_CREDENTIALS_KEYRING = JSON.stringify({
      '2026-10': '33'.repeat(32),
      '2026-11': '44'.repeat(32),
    });
    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = '2026-11';
    const envelope = encryptConnectorCredential('rotated-secret', context);
    expect(envelope.keyId).toBe('2026-11');
    expect(decryptConnectorCredential(envelope, context)).toBe('rotated-secret');

    const previousEnvelope = (() => {
      process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = '2026-10';
      return encryptConnectorCredential('previous-secret', context);
    })();
    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = '2026-11';
    expect(decryptConnectorCredential(previousEnvelope, context)).toBe('previous-secret');
  });

  it('continues to decrypt legacy envelopes while the legacy key is retained', () => {
    const legacyEnvelope = encryptConnectorCredential('legacy-secret', context);
    expect(legacyEnvelope.keyId).toBeUndefined();
    process.env.CONNECTOR_CREDENTIALS_KEYRING = JSON.stringify({ active: '55'.repeat(32) });
    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = 'active';
    expect(decryptConnectorCredential(legacyEnvelope, context)).toBe('legacy-secret');
  });

  it('fails closed for unknown key IDs and invalid active key configuration', () => {
    process.env.CONNECTOR_CREDENTIALS_KEYRING = JSON.stringify({ active: '66'.repeat(32) });
    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = 'missing';
    expect(() => encryptConnectorCredential('secret', context)).toThrow('ACTIVE_KEY_ID');

    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = 'active';
    const envelope = encryptConnectorCredential('secret', context);
    expect(() => decryptConnectorCredential({ ...envelope, keyId: 'retired' }, context))
      .toThrow('encryption key is unavailable');
  });

  it('rejects payloads larger than 64 KiB', () => {
    expect(() => encryptConnectorCredential('x'.repeat(65 * 1024), context)).toThrow('64 KiB');
  });
});
