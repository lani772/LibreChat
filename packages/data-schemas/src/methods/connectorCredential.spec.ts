import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage } from '~/config/tenantContext';
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
    const raw = await mongoose.models.ConnectorCredential.findOne({
      installationId: String(installation._id),
    }).select('+encryptedPayload').lean();
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
});
