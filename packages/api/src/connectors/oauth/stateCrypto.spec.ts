import { decryptGoogleOAuthVerifier, encryptGoogleOAuthVerifier } from './stateCrypto';

describe('Google OAuth PKCE verifier encryption', () => {
  const originalKey = process.env.CONNECTOR_OAUTH_STATE_KEY;
  const context = {
    stateHash: 'A'.repeat(43),
    tenantId: 'tenant-a',
    principalId: 'user-a',
    installationId: '64b000000000000000000001',
    redirectUri: 'https://app.example.test/api/connectors/google-workspace/callback',
    expiresAt: 1790000000000,
  };

  beforeEach(() => {
    process.env.CONNECTOR_OAUTH_STATE_KEY = '22'.repeat(32);
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CONNECTOR_OAUTH_STATE_KEY;
    else process.env.CONNECTOR_OAUTH_STATE_KEY = originalKey;
  });

  it('round-trips the verifier without persisting plaintext', () => {
    const verifier = 'pkce-verifier-that-must-not-be-stored-in-plaintext';
    const envelope = encryptGoogleOAuthVerifier(verifier, context);
    expect(envelope).not.toContain(verifier);
    expect(decryptGoogleOAuthVerifier(envelope, context)).toBe(verifier);
  });

  it('binds the verifier to the exact OAuth transaction and identity', () => {
    const envelope = encryptGoogleOAuthVerifier('secret-verifier', context);
    expect(() =>
      decryptGoogleOAuthVerifier(envelope, { ...context, tenantId: 'tenant-b' }),
    ).toThrow();
    expect(() =>
      decryptGoogleOAuthVerifier(envelope, { ...context, stateHash: 'B'.repeat(43) }),
    ).toThrow();
    expect(() =>
      decryptGoogleOAuthVerifier(envelope, {
        ...context,
        installationId: '64b000000000000000000002',
      }),
    ).toThrow();
  });

  it('fails closed when the independent state key is absent or malformed', () => {
    delete process.env.CONNECTOR_OAUTH_STATE_KEY;
    expect(() => encryptGoogleOAuthVerifier('secret', context)).toThrow(
      'CONNECTOR_OAUTH_STATE_KEY',
    );
    process.env.CONNECTOR_OAUTH_STATE_KEY = 'bad-key';
    expect(() => encryptGoogleOAuthVerifier('secret', context)).toThrow(
      'CONNECTOR_OAUTH_STATE_KEY',
    );
  });

  it('rejects malformed envelopes', () => {
    expect(() => decryptGoogleOAuthVerifier('{}', context)).toThrow();
    expect(() => decryptGoogleOAuthVerifier('not-json', context)).toThrow();
  });
});
