import {
  decryptConnectorCredential,
  encryptConnectorCredential,
} from './credentialCrypto';

describe('connector credential authenticated encryption', () => {
  const originalKey = process.env.CONNECTOR_CREDENTIALS_KEY;
  const context = {
    tenantId: 'tenant-a',
    installationId: '64b000000000000000000001',
    provider: 'chatwoot',
  };

  beforeEach(() => {
    process.env.CONNECTOR_CREDENTIALS_KEY = '11'.repeat(32);
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEY;
    else process.env.CONNECTOR_CREDENTIALS_KEY = originalKey;
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

  it('rejects payloads larger than 64 KiB', () => {
    expect(() => encryptConnectorCredential('x'.repeat(65 * 1024), context)).toThrow('64 KiB');
  });
});
