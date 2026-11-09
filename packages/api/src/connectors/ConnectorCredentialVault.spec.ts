import type { ConnectorService } from './ConnectorService';
import { ConnectorCredentialVault } from './ConnectorCredentialVault';

describe('ConnectorCredentialVault', () => {
  const originalKey = process.env.CONNECTOR_CREDENTIALS_KEY;
  const installationId = '64b000000000000000000001';
  const context = { tenantId: 'tenant-a', installationId, provider: 'chatwoot' };
  const store = {
    putConnectorCredential: jest.fn(),
    getConnectorCredentialCiphertext: jest.fn(),
    deleteConnectorCredential: jest.fn(),
    claimConnectorCredentialRefresh: jest.fn(),
    releaseConnectorCredentialRefresh: jest.fn(),
  };
  const execute = jest.fn();
  const connectorService = { execute } as unknown as ConnectorService;
  let vault: ConnectorCredentialVault;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONNECTOR_CREDENTIALS_KEY = '22'.repeat(32);
    vault = new ConnectorCredentialVault(store, connectorService, () => 'tenant-a');
    store.putConnectorCredential.mockResolvedValue({
      installationId,
      provider: 'chatwoot',
      credentialPresent: true,
      updatedAt: new Date(),
    });
    store.deleteConnectorCredential.mockResolvedValue({ deleted: true });
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEY;
    else process.env.CONNECTOR_CREDENTIALS_KEY = originalKey;
  });

  it('encrypts credentials before persistence and stores no plaintext', async () => {
    await vault.storeCredentials(installationId, 'chatwoot', { apiToken: 'plaintext-secret' });
    const stored = store.putConnectorCredential.mock.calls[0][0];
    expect(stored.encryptedPayload).not.toContain('plaintext-secret');
    expect(stored.keyVersion).toBe('gcm1');
    expect(stored.provider).toBe('chatwoot');
  });

  it('decrypts only inside an authorized ConnectorService execution', async () => {
    store.getConnectorCredentialCiphertext.mockImplementation(async () => {
      const { encryptConnectorCredential } = await import('./credentialCrypto');
      return {
        ...context,
        encryptedPayload: JSON.stringify(
          encryptConnectorCredential(JSON.stringify({ apiToken: 'secret-value' }), context),
        ),
        keyVersion: 'gcm1',
      };
    });
    execute.mockImplementation(async (_id, callback) =>
      callback({
        tenantId: 'tenant-a',
        principalId: 'user-a',
        installation: { provider: 'chatwoot' },
      }),
    );

    const result = await vault.withCredentials(installationId, async (credentials) =>
      credentials.apiToken,
    );
    expect(result).toBe('secret-value');
    expect(execute).toHaveBeenCalledWith(installationId, expect.any(Function));
    expect(store.getConnectorCredentialCiphertext).toHaveBeenCalledWith(installationId);
  });

  it('does not read or decrypt credentials when connector authorization fails', async () => {
    const denial = new Error('denied');
    execute.mockRejectedValue(denial);
    await expect(
      vault.withCredentials(installationId, async () => 'should-not-run'),
    ).rejects.toBe(denial);
    expect(store.getConnectorCredentialCiphertext).not.toHaveBeenCalled();
  });

  it('rejects ciphertext bound to a different tenant', async () => {
    const { encryptConnectorCredential } = await import('./credentialCrypto');
    const envelope = encryptConnectorCredential('{"apiToken":"secret"}', context);
    store.getConnectorCredentialCiphertext.mockResolvedValue({
      tenantId: 'tenant-b',
      installationId,
      provider: 'chatwoot',
      encryptedPayload: JSON.stringify(envelope),
      keyVersion: 'gcm1',
    });
    execute.mockImplementation(async (_id, callback) =>
      callback({
        tenantId: 'tenant-a',
        principalId: 'user-a',
        installation: { provider: 'chatwoot' },
      }),
    );
    await expect(vault.withCredentials(installationId, async () => 'no')).rejects.toThrow();
  });
});
