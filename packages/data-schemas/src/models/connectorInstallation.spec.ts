import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage } from '~/config/tenantContext';
import { createConnectorInstallationModel } from './connectorInstallation';
import { _resetStrictCache } from './plugins/tenantIsolation';
import { createConnectorInstallationMethods } from '~/methods/connectorInstallation';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createConnectorInstallationModel(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('connector installation persistence', () => {
  const methods = () => createConnectorInstallationMethods(mongoose);

  beforeEach(async () => {
    await mongoose.models.ConnectorInstallation.deleteMany({});
  });

  it('stamps tenant scope and never exposes credential references in list results', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace',
        displayName: 'Google Workspace',
        visibility: 'personal',
        credentialRef: 'vault-ref-123',
      }),
    );
    expect(created.tenantId).toBe('tenant-a');
    expect(created.ownerUserId).toBe('user-a');
    expect(created.credentialRef).toBeUndefined();

    const listed = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().listConnectorInstallations(),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].credentialRef).toBeUndefined();
  });

  it('does not return installations belonging to another tenant', async () => {
    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().createConnectorInstallation({
        ownerUserId: 'user-a',
        provider: 'chatwoot',
        displayName: 'Support',
        visibility: 'personal',
      }),
    );
    const visible = await tenantStorage.run({ tenantId: 'tenant-b', userId: 'user-b' }, () =>
      methods().listConnectorInstallations(),
    );
    expect(visible).toHaveLength(0);
  });

  it('uses optimistic version checks and enforces lifecycle transitions', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().createConnectorInstallation({
        ownerUserId: 'user-a',
        provider: 'n8n',
        displayName: 'Automation',
        visibility: 'tenant',
      }),
    );

    const authorizing = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id),
        expectedVersion: 0,
        state: 'authorizing',
      }),
    );
    expect(authorizing?.state).toBe('authorizing');
    expect(authorizing?.version).toBe(1);

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 1,
          state: 'connected',
        }),
      ),
    ).resolves.toMatchObject({ state: 'connected', version: 2 });

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 0,
          state: 'connected',
        }),
      ),
    ).resolves.toBeNull();
  });

  it('rejects invalid lifecycle transitions', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().createConnectorInstallation({
        ownerUserId: 'user-a',
        provider: 'n8n',
        displayName: 'Automation',
        visibility: 'personal',
      }),
    );
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a' }, () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 0,
          state: 'connected',
        }),
      ),
    ).rejects.toThrow('Invalid connector state transition');
  });

  it('refuses unscoped creation even when global tenant strict mode is disabled', async () => {
    await expect(
      methods().createConnectorInstallation({
        ownerUserId: 'user-a',
        provider: 'google-workspace',
        displayName: 'Google Workspace',
        visibility: 'personal',
      }),
    ).rejects.toThrow('requires an active tenant context');
  });

  it('revokes an installation and removes its credential reference', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().createConnectorInstallation({
        ownerUserId: 'user-a',
        provider: 'chatwoot',
        displayName: 'Support',
        visibility: 'personal',
        credentialRef: 'vault-ref-456',
      }),
    );
    const revoked = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      methods().revokeConnectorInstallation(String(created._id)),
    );
    expect(revoked).toBe(true);
    const stored = await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      mongoose.models.ConnectorInstallation.findById(created._id)
        .select('+credentialRef')
        .lean(),
    );
    expect(stored?.state).toBe('revoked');
    expect(stored?.credentialRef).toBeNull();
  });

  it('requires a tenant context when strict isolation is enabled', async () => {
    const previous = process.env.TENANT_ISOLATION_STRICT;
    process.env.TENANT_ISOLATION_STRICT = 'true';
    _resetStrictCache();
    try {
      await expect(
        methods().listConnectorInstallations(),
      ).rejects.toThrow('requires an active tenant context');
    } finally {
      if (previous == null) delete process.env.TENANT_ISOLATION_STRICT;
      else process.env.TENANT_ISOLATION_STRICT = previous;
      _resetStrictCache();
    }
  });
});
