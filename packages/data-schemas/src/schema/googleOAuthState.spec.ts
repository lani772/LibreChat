import googleOAuthStateSchema from './googleOAuthState';

describe('Google OAuth state schema', () => {
  it('enforces unique state hashes and automatic expiry', () => {
    const indexes = googleOAuthStateSchema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { stateHash: 1 },
          expect.objectContaining({ unique: true, name: 'google_oauth_state_hash_unique' }),
        ],
        [
          { expiresAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 0, name: 'google_oauth_state_ttl' }),
        ],
      ]),
    );
  });

  it('keeps the encrypted PKCE verifier excluded from ordinary reads', () => {
    expect(googleOAuthStateSchema.path('encryptedCodeVerifier').options.select).toBe(false);
    expect(googleOAuthStateSchema.options.strict).toBe('throw');
  });

  it('requires a tenant, principal, installation, redirect, verifier envelope, and expiry', () => {
    for (const field of [
      'stateHash',
      'tenantId',
      'principalId',
      'installationId',
      'redirectUri',
      'encryptedCodeVerifier',
      'expiresAt',
    ]) {
      expect(googleOAuthStateSchema.path(field).options.required).toBe(true);
    }
  });
});
