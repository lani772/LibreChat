import { GoogleWorkspaceTokenLifecycle } from './GoogleWorkspaceTokenLifecycle';
import { GoogleWorkspaceOAuthError } from './GoogleWorkspaceOAuthAdapter';

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
    withCredentials: jest.fn(async (_id: string, operation: (value: typeof stored, snapshot: { tenantId: string; installationId: string; provider: string; encryptedPayload: string }) => Promise<unknown>) =>
      operation(stored, { tenantId: 'tenant-a', installationId: _id, provider: 'google-workspace', encryptedPayload: JSON.stringify({ version: 'gcm1', ciphertext: 'encrypted' }) }),
    ),
    claimRefreshLease: jest.fn().mockResolvedValue(true),
    releaseRefreshLease: jest.fn().mockResolvedValue(true),
    storeCredentials: jest.fn(async (_id: string, _provider: string, values: typeof stored) => {
      stored = { ...values };
      return { credentialPresent: true };
    }),
  };
  const revocations = {
    enqueueGoogleWorkspaceRevocation: jest.fn().mockResolvedValue({ id: 'job-1', state: 'pending' }),
  };
  const installations = {
    getConnectorInstallation: jest.fn().mockResolvedValue({ ...installation }),
    transitionConnectorInstallation: jest.fn().mockResolvedValue({}),
    revokeConnectorInstallation: jest.fn().mockResolvedValue(true),
  };
  const lifecycle = new GoogleWorkspaceTokenLifecycle({
    adapter,
    vault: vault as never,
    revocations,
    installations,
    now: () => 5_000,
    newLeaseToken: () => 'lease-token',
  });
  return { lifecycle, adapter, vault, installations, revocations, getStored: () => stored };
}

describe('GoogleWorkspaceTokenLifecycle', () => {
  it('refreshes an expired token and preserves the refresh token when Google omits rotation', async () => {
    const { lifecycle, adapter, vault, getStored } = setup();
    await expect(lifecycle.getAccessToken('507f1f77bcf86cd799439011')).resolves.toBe('new-access');
    expect(adapter.refreshAccessToken).toHaveBeenCalledWith({ refreshToken: 'stable-refresh' });
    expect(vault.claimRefreshLease).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
      'lease-token',
      120_000,
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

  it('marks the installation for reauthorization when Google rejects a refresh grant', async () => {
    const { lifecycle, adapter, installations } = setup();
    adapter.refreshAccessToken.mockRejectedValue(
      new GoogleWorkspaceOAuthError('Google OAuth request failed (HTTP 400)', 400, 'invalid_grant'),
    );
    await expect(lifecycle.getAccessToken('507f1f77bcf86cd799439011')).rejects.toThrow('HTTP 400');
    expect(installations.transitionConnectorInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'error',
        lastErrorCode: 'google_reauthorization_required',
      }),
    );
  });

  it('persists an encrypted revocation job before local credential cleanup', async () => {
    const { lifecycle, installations, revocations } = setup();
    await expect(lifecycle.disconnect('507f1f77bcf86cd799439011')).resolves.toEqual({
      disconnected: true,
      remoteRevocation: 'pending',
    });
    expect(revocations.enqueueGoogleWorkspaceRevocation).toHaveBeenCalledWith({
      installationId: '507f1f77bcf86cd799439011',
      encryptedPayload: JSON.stringify({ version: 'gcm1', ciphertext: 'encrypted' }),
    });
    expect(installations.revokeConnectorInstallation).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439011',
    );
  });

  it('falls back to immediate remote revocation if the durable outbox is unavailable', async () => {
    const { lifecycle, adapter, revocations } = setup();
    revocations.enqueueGoogleWorkspaceRevocation.mockRejectedValue(new Error('database unavailable'));
    await expect(lifecycle.disconnect('507f1f77bcf86cd799439011')).resolves.toEqual({
      disconnected: true,
      remoteRevocation: 'confirmed',
    });
    expect(adapter.revokeToken).toHaveBeenCalledWith({ token: 'stable-refresh' });
  });

  it('reports when remote revocation fails and durable retry could not be queued', async () => {
    const { lifecycle, adapter, revocations } = setup();
    revocations.enqueueGoogleWorkspaceRevocation.mockRejectedValue(new Error('database unavailable'));
    adapter.revokeToken.mockRejectedValue(new Error('provider unavailable'));
    await expect(lifecycle.disconnect('507f1f77bcf86cd799439011')).resolves.toEqual({
      disconnected: true,
      remoteRevocation: 'retry_unavailable',
    });
  });
});
