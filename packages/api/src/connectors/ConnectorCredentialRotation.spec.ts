import {
  decryptConnectorCredential,
  encryptConnectorCredential,
} from './credentialCrypto';
import {
  rotateConnectorCredentialEncryption,
  type ConnectorCredentialRotationStore,
} from './ConnectorCredentialRotation';

describe('connector credential encryption rotation', () => {
  const original = {
    legacy: process.env.CONNECTOR_CREDENTIALS_KEY,
    keyring: process.env.CONNECTOR_CREDENTIALS_KEYRING,
    active: process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID,
  };
  const context = {
    tenantId: 'tenant-rotation',
    installationId: '64b000000000000000000099',
    provider: 'google-workspace',
  };

  beforeEach(() => {
    process.env.CONNECTOR_CREDENTIALS_KEY = '11'.repeat(32);
    delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
  });

  afterAll(() => {
    if (original.legacy === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEY;
    else process.env.CONNECTOR_CREDENTIALS_KEY = original.legacy;
    if (original.keyring === undefined) delete process.env.CONNECTOR_CREDENTIALS_KEYRING;
    else process.env.CONNECTOR_CREDENTIALS_KEYRING = original.keyring;
    if (original.active === undefined) delete process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID;
    else process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = original.active;
  });

  function useActiveKeyring() {
    process.env.CONNECTOR_CREDENTIALS_KEYRING = JSON.stringify({ 'key-2026-11': '22'.repeat(32) });
    process.env.CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID = 'key-2026-11';
  }

  function createLegacyRow(id = '64b000000000000000000001') {
    const encryptedPayload = JSON.stringify(
      encryptConnectorCredential(JSON.stringify({ refreshToken: 'secret-refresh-token' }), context),
    );
    return {
      id,
      ...context,
      encryptedPayload,
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    };
  }

  function createStore(rows: ReturnType<typeof createLegacyRow>[]): ConnectorCredentialRotationStore {
    return {
      listConnectorCredentialsForRotation: jest.fn(async ({ afterId, limit }) =>
        rows.filter((row) => !afterId || row.id > afterId).slice(0, limit),
      ),
      replaceConnectorCredentialForRotation: jest.fn(async ({ id, expectedEncryptedPayload, encryptedPayload }) => {
        const row = rows.find((item) => item.id === id);
        if (!row || row.encryptedPayload !== expectedEncryptedPayload) return false;
        row.encryptedPayload = encryptedPayload;
        return true;
      }),
    };
  }

  it('rotates legacy envelopes and verifies the new ciphertext decrypts with the active key', async () => {
    const row = createLegacyRow();
    const store = createStore([row]);
    useActiveKeyring();

    const result = await rotateConnectorCredentialEncryption({ store, batchSize: 10 });

    expect(result).toMatchObject({ scanned: 1, migrated: 1, failed: 0, complete: true });
    const envelope = JSON.parse(row.encryptedPayload);
    expect(envelope.keyId).toBe('key-2026-11');
    expect(
      decryptConnectorCredential(envelope, context),
    ).toBe(JSON.stringify({ refreshToken: 'secret-refresh-token' }));
  });

  it('supports dry-run without writing any credential', async () => {
    const row = createLegacyRow();
    const before = row.encryptedPayload;
    const store = createStore([row]);
    useActiveKeyring();

    const result = await rotateConnectorCredentialEncryption({ store, dryRun: true });

    expect(result.migrated).toBe(1);
    expect(row.encryptedPayload).toBe(before);
    expect(store.replaceConnectorCredentialForRotation).not.toHaveBeenCalled();
  });

  it('stops safely on an undecryptable row and returns the last safe cursor', async () => {
    const first = createLegacyRow('64b000000000000000000001');
    const bad = { ...createLegacyRow('64b000000000000000000002'), encryptedPayload: 'not-json' };
    const store = createStore([first, bad]);
    useActiveKeyring();

    const result = await rotateConnectorCredentialEncryption({ store, batchSize: 10 });

    expect(result).toMatchObject({
      scanned: 2,
      migrated: 1,
      failed: 1,
      complete: false,
      resumeAfterId: first.id,
    });
  });

  it('does not overwrite a credential changed by another process', async () => {
    const row = createLegacyRow();
    const store = createStore([row]);
    store.replaceConnectorCredentialForRotation = jest.fn(async () => false);
    useActiveKeyring();

    const result = await rotateConnectorCredentialEncryption({ store });

    expect(result.conflicts).toBe(1);
    expect(result.migrated).toBe(0);
  });

  it('requires an active versioned keyring and enforces bounded batches', async () => {
    const store = createStore([createLegacyRow()]);
    await expect(rotateConnectorCredentialEncryption({ store })).rejects.toThrow(
      'active versioned credential keyring',
    );
    useActiveKeyring();
    await expect(rotateConnectorCredentialEncryption({ store, batchSize: 101 })).rejects.toThrow(
      'batch size',
    );
  });
});
