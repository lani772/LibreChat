import { encryptConnectorCredential } from '../credentialCrypto';
import {
  processGoogleWorkspaceRevocationBatch,
  type GoogleWorkspaceRevocationStore,
} from './GoogleWorkspaceRevocationWorker';

describe('GoogleWorkspaceRevocationWorker', () => {
  const original = {
    key: process.env.CONNECTOR_CREDENTIALS_KEY,
    keyring: process.env.CONNECTOR_CREDENTIALS_KEYRING,
    active: process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID,
  };
  const context = {
    tenantId: 'tenant-a',
    installationId: '64b000000000000000000099',
    provider: 'google-workspace',
  };

  beforeEach(() => {
    process.env.CONNECTOR_CREDENTIALS_KEY = '11'.repeat(32);
    delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
  });

  afterAll(() => {
    if (original.key === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEY;
    else process.env.CONNECTOR_CREDENTIALS_KEY = original.key;
    if (original.keyring === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    else process.env.CONNECTOR_CREDENTIALS_KEYRING = original.keyring;
    if (original.active === undefined) delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
    else process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = original.active;
  });

  function createJob() {
    const encryptedPayload = JSON.stringify(
      encryptConnectorCredential(
        JSON.stringify({ refreshToken: 'sensitive-refresh-token', accessToken: 'access-token' }),
        context,
      ),
    );
    return {
      id: 'job-1',
      ...context,
      encryptedPayload,
      attempts: 1,
      leaseToken: 'lease-1',
      provider: 'google-workspace' as const,
    };
  }

  function setup(job = createJob()) {
    const store: GoogleWorkspaceRevocationStore = {
      claimGoogleWorkspaceRevocation: jest.fn(async () => job),
      isConnectorInstallationRevokedForSystem: jest.fn(async () => true),
      completeGoogleWorkspaceRevocation: jest.fn(async () => true),
      retryGoogleWorkspaceRevocation: jest.fn(async () => 'rescheduled' as const),
    };
    const adapter = { revokeToken: jest.fn().mockResolvedValue(undefined) };
    return { store, adapter, job };
  }

  it('decrypts only in the worker and remotely revokes then clears the outbox job', async () => {
    const h = setup();
    const result = await processGoogleWorkspaceRevocationBatch({
      store: h.store,
      adapter: h.adapter,
      newLeaseToken: () => 'worker-lease',
      now: () => 10_000,
    });
    expect(result).toEqual({
      claimed: 1,
      completed: 1,
      rescheduled: 0,
      dead: 0,
      leaseLost: 0,
    });
    expect(h.adapter.revokeToken).toHaveBeenCalledWith({ token: 'sensitive-refresh-token' });
    expect(h.store.completeGoogleWorkspaceRevocation).toHaveBeenCalledWith({
      id: 'job-1',
      leaseToken: 'lease-1',
    });
  });

  it('waits for local revocation before contacting Google', async () => {
    const h = setup();
    jest.mocked(h.store.isConnectorInstallationRevokedForSystem).mockResolvedValue(false);
    const result = await processGoogleWorkspaceRevocationBatch({
      store: h.store,
      adapter: h.adapter,
      newLeaseToken: () => 'worker-lease',
      now: () => 10_000,
    });
    expect(h.adapter.revokeToken).not.toHaveBeenCalled();
    expect(h.store.retryGoogleWorkspaceRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'installation_not_revoked' }),
    );
    expect(result.rescheduled).toBe(1);
  });

  it('retries provider failures with bounded backoff and safe error codes', async () => {
    const h = setup();
    h.adapter.revokeToken.mockRejectedValue(new Error('secret token in provider response'));
    const result = await processGoogleWorkspaceRevocationBatch({
      store: h.store,
      adapter: h.adapter,
      newLeaseToken: () => 'worker-lease',
      now: () => 10_000,
    });
    expect(h.store.retryGoogleWorkspaceRevocation).toHaveBeenCalledWith({
      id: 'job-1',
      leaseToken: 'lease-1',
      nextAttemptAt: new Date(40_000),
      errorCode: 'google_revocation_failed',
      maxAttempts: 12,
    });
    expect(result.rescheduled).toBe(1);
    expect(JSON.stringify(h.store.retryGoogleWorkspaceRevocation.mock.calls)).not.toContain('secret token');
  });

  it('counts stale lease completion as lost and enforces worker bounds', async () => {
    const h = setup();
    jest.mocked(h.store.completeGoogleWorkspaceRevocation).mockResolvedValue(false);
    const result = await processGoogleWorkspaceRevocationBatch({
      store: h.store,
      adapter: h.adapter,
      newLeaseToken: () => 'worker-lease',
    });
    expect(result.leaseLost).toBe(1);
    await expect(
      processGoogleWorkspaceRevocationBatch({ store: h.store, adapter: h.adapter, batchSize: 101 }),
    ).rejects.toThrow('worker limits');
  });
});
