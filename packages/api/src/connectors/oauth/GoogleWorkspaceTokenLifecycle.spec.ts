import { GoogleWorkspaceTokenLifecycle } from './GoogleWorkspaceTokenLifecycle';

const installation = {
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  provider: 'google-workspace',
  state: 'connected',
  version: 4,
};

function setup(initial = {
  accessToken: 'old-access',
  refreshToken: 'stable-refresh',
  expiresAt: 1_000,
  scopes: ['scope.read'],
  tokenType: 'Bearer',
}) {
  let stored = { ...initial };
  const adapter = {
    refreshAccessToken: jest.fn().mockImplementation(async () => ({
      accessToken: 'new-access',
      // Google commonly omits refresh_token on refresh. The existing token must survive.
      refreshToken: undefined,
      expiresAt: 10_000_000,
      scopes: [],
      tokenType: 'Bearer',
    })),
    revokeToken: jest.fn().mockResolvedValue(undefined),
  };
  const vault = {
    withCredentials: jest.fn(async (_id: string, operation: (value: typeof stored) => Promise<unknown>) =>
      operation(stored),
    ),
    claimRefreshLease: jest.fn().mockResolvedValue(true),
    releaseRefreshLease: jest.fn().mockResolvedValue(true),
    storeCredentials: jest.fn(async (_id: string, _provider: string, values: typeof stored) => {
      stored = { ...values };
      return { credentialPresent: true };
    }),
  };
  const installations = {
    getConnectorInstallation: jest.fn().mockResolvedValue({ ...installation }),
    transitionConnectorInstallation: jest.fn().mockResolvedValue({}),
    revokeConnectorInstallation: jest.fn().mockResolvedValue(true),
  };
  const lifecycle = new GoogleWorkspaceTokenLifecycle({
    adapter,
    vault,
    installations,
    now: () => 5_000,
    newLeaseToken: () => 'lease-token',
  });
  return { lifecycle, adapter, vault, installations, getStored: () => stored };
}

describe('GoogleWorkspaceTokenLifecycle', () => {
  it('refreshes an expired token and preserves the refresh token when Google omits rotation', async () => {
    const { lifecycle, adapter, vault, getStored } = setup();
    await expect(lifecycle.getAccessToken('507f1f77bcf86cd799439011')).resolves.toBe('new-access');
    expect(adapter.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'stable-refresh' });
    expect(vault.claimRefreshLease).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      'lease-token',
      30_000,
    );
    expect(vault.storeCredentials).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      'google-workspace',
      expect.objectContaining({ refreshToken: 'stable-refresh', accessToken: 'new-access' }),
      { refreshLeaseToken: 'lease-token' },
    );
    expect(getStored().refreshToken).toBe('stable-refresh');
  });

  it('does not refresh a token that remains valid beyond the safety window', async () => {
    const { lifecycle, adapter } = setup({
      accessToken: 'valid-access',
      refreshToken: 'stable-refresh',
      expiresAt: 600_000,
      scopes: ['scope.read'],
      tokenType: 'Bearer',
    });
    await expect(lifecycle.getAccessToken('507f1f77bcf86cd799439011')).resolves.toBe('valid-access');
    expect(adapter.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('uses a distributed lease and retries when another process owns the refresh', async () => {
    const { lifecycle, vault, adapter } = setup();
    vault.claimRefreshLease
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(lifecycle.getAccessToken('507f1f77bcf86cd799439011')).resolves.toBe('new-access');
    expect(vault.claimRefreshLease).toHaveBeenCalledTimes(2);
    expect(adapter.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('revokes locally even if Google remote revocation is unavailable', async () => {
    const { lifecycle, adapter, installations } = setup();
    adapter.revokeToken.mockRejectedValue(new Error('provider unavailable'));
    await expect(lifecycle.disconnect('507f1f77bcf86cd799439011')).resolves.toEqual({
      disconnected: true,
      remoteRevocation: 'pending',
    });
    expect(installations.revokeConnectorInstallation).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
    );
  });

  it('reports successful remote revocation and local credential cleanup', async () => {
    const { lifecycle, adapter } = setup();
    await expect(lifecycle.disconnect('507f1f77bcf86cd799439011')).resolves.toEqual({
      disconnected: true,
      remoteRevocation: 'confirmed',
    });
    expect(adapter.revokeToken).toHaveBeenCalledWith({ token: 'stable-refresh' });
  });
});
