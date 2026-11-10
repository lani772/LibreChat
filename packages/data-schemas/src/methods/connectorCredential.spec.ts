import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createConnectorInstallationModel } from '~/models/connectorInstallation';
import { createConnectorCredentialModel } from '~/models/connectorCredential';
import { createConnectorCredentialMethods } from './connectorCredential';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createConnectorInstallationModel(mongoose);
  createConnectorCredentialModel(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('connector credential persistence', () => {
  const methods = () => createConnectorCredentialMethods(mongoose);

  beforeEach(async () => {
    await mongoose.models.ConnectorCredential.deleteMany({});
    await mongoose.models.ConnectorInstallation.deleteMany({});
  });

  async function createInstallation(tenantId = 'tenant-a', userId = 'owner-a') {
    return tenantStorage.run({ tenantId, userId }, async () =>
      mongoose.models.ConnectorInstallation.create({
        ownerUserId: userId,
        provider: 'chatwoot',
        instanceKey: 'opaque-instance-key',
        displayName: 'Support',
        visibility: 'personal',
        state: 'disconnected',
        grantedPrincipalIds: [],
        version: 0,
      }),
    );
  }

  it('stores ciphertext only and returns a safe summary', async () => {
    const installation = await createInstallation();
    const ciphertext = JSON.stringify({
      version: 'gcm1',
      nonce: 'a'.repeat(24),
      tag: 'b'.repeat(32),
      ciphertext: 'c0ffee',
    });
    const summary = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'owner-a' },
      () =>
        methods().putConnectorCredential({
          installationId: String(installation._id),
          provider: 'chatwoot',
          encryptedPayload: ciphertext,
          keyVersion: 'gcm1',
        }),
    );
    expect(summary).toMatchObject({
      installationId: String(installation._id),
      provider: 'chatwoot',
      credentialPresent: true,
    });
    const ordinaryRead = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'owner-a' },
      async () =>
        mongoose.models.ConnectorCredential.findOne({
          installationId: String(installation._id),
        }).lean(),
    );
    expect(ordinaryRead?.encryptedPayload).toBeUndefined();

    const raw = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'owner-a' },
      async () =>
        mongoose.models.ConnectorCredential.findOne({
          installationId: String(installation._id),
        })
          .select('+encryptedPayload')
          .lean(),
    );
    expect(raw?.encryptedPayload).toBe(ciphertext);
    expect(JSON.stringify(summary)).not.toContain(ciphertext);
  });

  it('derives owner from trusted context and denies another user writing credentials', async () => {
    const installation = await createInstallation();
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'attacker' }, () =>
        methods().putConnectorCredential({
          installationId: String(installation._id),
          provider: 'chatwoot',
          encryptedPayload: 'opaque-ciphertext',
          keyVersion: 'gcm1',
        }),
      ),
    ).rejects.toThrow('unavailable');
  });

  it('does not allow a credential from another tenant to be read', async () => {
    const installation = await createInstallation();
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId: String(installation._id),
        provider: 'chatwoot',
        encryptedPayload: 'opaque-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    const crossTenant = await tenantStorage.run(
      { tenantId: 'tenant-b', userId: 'owner-a' },
      () => methods().getConnectorCredentialCiphertext(String(installation._id)),
    );
    expect(crossTenant).toBeNull();
  });

  it('returns ciphertext only through the explicitly named internal method', async () => {
    const installation = await createInstallation();
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId: String(installation._id),
        provider: 'chatwoot',
        encryptedPayload: 'opaque-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    const stored = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'owner-a' },
      () => methods().getConnectorCredentialCiphertext(String(installation._id)),
    );
    expect(stored).toMatchObject({
      tenantId: 'tenant-a',
      installationId: String(installation._id),
      provider: 'chatwoot',
      encryptedPayload: 'opaque-ciphertext',
      keyVersion: 'gcm1',
    });
  });

  it('allows only one concurrent process to claim the refresh lease', async () => {
    const installation = await createInstallation();
    const installationId = String(installation._id);
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId,
        provider: 'chatwoot',
        encryptedPayload: 'initial-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    const leaseUntil = new Date(Date.now() + 30_000);
    const first = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().claimConnectorCredentialRefresh({
        installationId,
        leaseToken: 'process-one',
        leaseUntil,
      }),
    );
    const second = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().claimConnectorCredentialRefresh({
        installationId,
        leaseToken: 'process-two',
        leaseUntil,
      }),
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('fences credential writes with the current refresh lease token', async () => {
    const installation = await createInstallation();
    const installationId = String(installation._id);
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId,
        provider: 'chatwoot',
        encryptedPayload: 'initial-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().claimConnectorCredentialRefresh({
        installationId,
        leaseToken: 'current-lease',
        leaseUntil: new Date(Date.now() + 30_000),
      }),
    );
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().putConnectorCredential({
          installationId,
          provider: 'chatwoot',
          encryptedPayload: 'refreshed-ciphertext',
          keyVersion: 'gcm1',
          refreshLeaseToken: 'stale-lease',
        }),
      ),
    ).rejects.toThrow('lease was lost');
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().putConnectorCredential({
          installationId,
          provider: 'chatwoot',
          encryptedPayload: 'refreshed-ciphertext',
          keyVersion: 'gcm1',
          refreshLeaseToken: 'current-lease',
        }),
      ),
    ).resolves.toMatchObject({ credentialPresent: true });
  });

  it('deletes credentials only for their installation owner', async () => {
    const installation = await createInstallation();
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId: String(installation._id),
        provider: 'chatwoot',
        encryptedPayload: 'opaque-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'other-user' }, () =>
        methods().deleteConnectorCredential(String(installation._id)),
      ),
    ).resolves.toEqual({ deleted: false });
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().deleteConnectorCredential(String(installation._id)),
      ),
    ).resolves.toEqual({ deleted: true });
  });
  it('restricts credential rotation scans to explicit system context', async () => {
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().listConnectorCredentialsForRotation({ limit: 10 }),
      ),
    ).rejects.toThrow('explicit system context');
  });

  it('scans bounded credential batches across tenants only in system context', async () => {
    const first = await createInstallation('tenant-a', 'owner-a');
    const second = await createInstallation('tenant-b', 'owner-b');
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId: String(first._id),
        provider: 'chatwoot',
        encryptedPayload: 'ciphertext-a',
        keyVersion: 'gcm1',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-b', userId: 'owner-b' }, () =>
      methods().putConnectorCredential({
        installationId: String(second._id),
        provider: 'chatwoot',
        encryptedPayload: 'ciphertext-b',
        keyVersion: 'gcm1',
      }),
    );

    const rows = await runAsSystem(async () =>
      methods().listConnectorCredentialsForRotation({ limit: 1 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: 'tenant-a',
      installationId: String(first._id),
      encryptedPayload: 'ciphertext-a',
    });
  });

  it('uses compare-and-set to replace ciphertext without overwriting concurrent writes', async () => {
    const installation = await createInstallation();
    const installationId = String(installation._id);
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId,
        provider: 'chatwoot',
        encryptedPayload: 'old-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    const [record] = await runAsSystem(async () =>
      methods().listConnectorCredentialsForRotation({ limit: 10 }),
    );
    expect(record).toBeDefined();
    const changed = await runAsSystem(async () =>
      methods().replaceConnectorCredentialForRotation({
        id: record.id,
        tenantId: record.tenantId,
        expectedEncryptedPayload: record.encryptedPayload,
        expectedUpdatedAt: record.updatedAt,
        encryptedPayload: 'new-ciphertext',
      }),
    );
    expect(changed).toBe(true);
    const [updated] = await runAsSystem(async () =>
      methods().listConnectorCredentialsForRotation({ limit: 10 }),
    );
    expect(updated.encryptedPayload).toBe('new-ciphertext');

    const stale = await runAsSystem(async () =>
      methods().replaceConnectorCredentialForRotation({
        id: record.id,
        tenantId: record.tenantId,
        expectedEncryptedPayload: 'old-ciphertext',
        expectedUpdatedAt: record.updatedAt,
        encryptedPayload: 'stale-ciphertext',
      }),
    );
    expect(stale).toBe(false);
    expect(updated.encryptedPayload).toBe('new-ciphertext');
  });

  it('excludes credentials with an active token refresh lease from rotation scans', async () => {
    const installation = await createInstallation();
    const installationId = String(installation._id);
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().putConnectorCredential({
        installationId,
        provider: 'chatwoot',
        encryptedPayload: 'leased-ciphertext',
        keyVersion: 'gcm1',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
      methods().claimConnectorCredentialRefresh({
        installationId,
        leaseToken: 'active-refresh',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    const rows = await runAsSystem(async () =>
      methods().listConnectorCredentialsForRotation({ limit: 10 }),
    );
    expect(rows).toHaveLength(0);
  });

});
