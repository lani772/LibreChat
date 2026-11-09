import { GoogleWorkspaceOAuthFlow, type GoogleOAuthPendingState } from './GoogleWorkspaceOAuthFlow';

const identity = { tenantId: 'tenant-a', principalId: 'user-a' };
const installation = {
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  tenantId: 'tenant-a',
  ownerUserId: 'user-a',
  provider: 'google-workspace',
  state: 'disconnected',
  version: 2,
};

function setup() {
  const pending = new Map<string, GoogleOAuthPendingState>();
  const adapter = {
    provider: 'google-workspace',
    exchangeAuthorizationCode: jest.fn().mockResolvedValue({
      accessToken: 'access-secret', refreshToken: 'refresh-secret',
      expiresAt: 123456, scopes: ['scope.read'], tokenType: 'Bearer',
    }),
    refreshAccessToken: jest.fn(),
    revokeToken: jest.fn(),
  };
  const vault = { storeCredentials: jest.fn().mockResolvedValue({ credentialPresent: true }) };
  const installations = {
    getConnectorInstallation: jest.fn().mockResolvedValue({ ...installation }),
    transitionConnectorInstallation: jest.fn().mockResolvedValue({}),
  };
  const states = {
    create: jest.fn(async (value: GoogleOAuthPendingState) => { pending.set(value.stateHash, value); }),
    consume: jest.fn(async (hash: string) => {
      const value = pending.get(hash) ?? null;
      pending.delete(hash);
      return value;
    }),
  };
  const runWithIdentity = jest.fn(<T>(_identity: { tenantId: string; principalId: string }, operation: () => Promise<T>): Promise<T> => operation());
  const flow = new GoogleWorkspaceOAuthFlow({
    adapter, vault, installations, states, runWithIdentity,
    clientId: 'client-id',
    redirectUri: 'https://app.example.test/oauth/google/callback',
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    now: () => 1_000_000,
    randomBytes: (size) => Buffer.alloc(size, size),
  });
  return { flow, adapter, vault, installations, states, runWithIdentity, pending };
}

describe('GoogleWorkspaceOAuthFlow', () => {
  it('creates a one-time state record and S256 PKCE authorization URL', async () => {
    const { flow, states } = setup();
    const result = await flow.begin({ identity, installationId: '507f1f77bcf86cd799439011' });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(states.create).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', principalId: 'user-a', codeVerifier: expect.any(String),
    }));
    expect(states.create.mock.calls[0][0].stateHash).not.toBe(url.searchParams.get('state'));
  });

  it('denies an installation owned by another principal or tenant', async () => {
    const { flow, installations, states } = setup();
    installations.getConnectorInstallation.mockResolvedValue({ ...installation, ownerUserId: 'other-user' });
    await expect(flow.begin({ identity, installationId: '507f1f77bcf86cd799439011' }))
      .rejects.toThrow('unavailable');
    expect(states.create).not.toHaveBeenCalled();
  });

  it('consumes state once, exchanges code with PKCE, and stores tokens in the vault', async () => {
    const { flow, vault, adapter, runWithIdentity } = setup();
    const started = await flow.begin({ identity, installationId: '507f1f77bcf86cd799439011' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const result = await flow.complete({ state, code: 'auth-code' });
    expect(result.connected).toBe(true);
    expect(adapter.exchangeAuthorizationCode).toHaveBeenCalledWith(expect.objectContaining({
      code: 'auth-code', redirectUri: 'https://app.example.test/oauth/google/callback',
      codeVerifier: expect.any(String),
    }));
    expect(runWithIdentity).toHaveBeenCalledWith(identity, expect.any(Function));
    expect(vault.storeCredentials).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011', 'google-workspace',
      expect.objectContaining({ accessToken: 'access-secret', refreshToken: 'refresh-secret' }),
    );
  });

  it('rejects replayed state', async () => {
    const { flow } = setup();
    const started = await flow.begin({ identity, installationId: '507f1f77bcf86cd799439011' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await flow.complete({ state, code: 'auth-code' });
    await expect(flow.complete({ state, code: 'auth-code' })).rejects.toThrow('invalid, expired, or already used');
  });

  it('rejects callback when installation has been revoked', async () => {
    const { flow, installations, adapter } = setup();
    const started = await flow.begin({ identity, installationId: '507f1f77bcf86cd799439011' });
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    installations.getConnectorInstallation
      .mockResolvedValueOnce({ ...installation })
      .mockResolvedValueOnce({ ...installation, state: 'revoked' });
    await expect(flow.complete({ state, code: 'auth-code' })).rejects.toThrow('unavailable');
    expect(adapter.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('rejects invalid callback inputs before consuming state', async () => {
    const { flow, states } = setup();
    await expect(flow.complete({ state: 'bad', code: 'code' })).rejects.toThrow('Invalid Google OAuth callback');
    expect(states.consume).not.toHaveBeenCalled();
  });
});
