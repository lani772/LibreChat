import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { tenantStorage } from '~/config/tenantContext';
import { createConnectorInstallationModel } from './connectorInstallation';
import { createConnectorCredentialModel } from './connectorCredential';
import { createMCPServerModel } from './mcpServer';
import { _resetStrictCache } from './plugins/tenantIsolation';
import { createConnectorInstallationMethods } from '~/methods/connectorInstallation';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createConnectorInstallationModel(mongoose);
  createConnectorCredentialModel(mongoose);
  createMCPServerModel(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('connector installation persistence', () => {
  const methods = () => createConnectorInstallationMethods(mongoose);

  beforeEach(async () => {
    await mongoose.models.ConnectorInstallation.deleteMany({});
    await mongoose.models.ConnectorCredential.deleteMany({});
  });

  it('stamps tenant scope and never exposes credential references in list results', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
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

    const listed = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().listConnectorInstallations(),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].credentialRef).toBeUndefined();
  });

  it('binds an installation only to an MCP server authored by its owner', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const otherOwnerId = new mongoose.Types.ObjectId();
    const installation = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: ownerId.toString() },
      async () =>
        methods().createConnectorInstallation({
          provider: 'chatwoot',
          displayName: 'Support',
          visibility: 'personal',
        }),
    );
    const ownedServer = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: ownerId.toString() },
      async () =>
        mongoose.models.MCPServer.create({
          serverName: 'support-owned',
          normalizedServerName: 'support-owned',
          config: { title: 'Support MCP' },
          author: ownerId,
        }),
    );
    const foreignServer = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: otherOwnerId.toString() },
      async () =>
        mongoose.models.MCPServer.create({
          serverName: 'support-foreign',
          normalizedServerName: 'support-foreign',
          config: { title: 'Foreign Support MCP' },
          author: otherOwnerId,
        }),
    );

    await expect(
      tenantStorage.run(
        { tenantId: 'tenant-a', userId: ownerId.toString() },
        async () =>
          methods().bindConnectorInstallationToMCPServer({
            installationId: String(installation._id),
            mcpServerId: String(foreignServer._id),
            expectedVersion: 0,
          }),
      ),
    ).resolves.toBeNull();

    const bound = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: ownerId.toString() },
      async () =>
        methods().bindConnectorInstallationToMCPServer({
          installationId: String(installation._id),
          mcpServerId: String(ownedServer._id),
          expectedVersion: 0,
        }),
    );
    expect(bound?.mcpServerId).toBe(String(ownedServer._id));
    expect(bound?.version).toBe(1);
    expect(bound?.credentialRef).toBeUndefined();

    const resolved = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: ownerId.toString() },
      async () => methods().getConnectorInstallationByMCPServerId(String(ownedServer._id)),
    );
    expect(resolved?._id.toString()).toBe(String(installation._id));
    expect(resolved?.credentialRef).toBeUndefined();

    // The MCP guard must still recognize a connector binding from a different tenant context.
    // It receives only the opaque installation ID; ConnectorService performs the actual
    // tenant comparison and denies the cross-tenant invocation.
    const crossTenantBinding = await tenantStorage.run(
      { tenantId: 'tenant-b', userId: otherOwnerId.toString() },
      async () =>
        methods().getConnectorInstallationBindingByMCPServerId(String(ownedServer._id)),
    );
    expect(crossTenantBinding?._id.toString()).toBe(String(installation._id));

    await expect(
      tenantStorage.run(
        { tenantId: 'tenant-a', userId: ownerId.toString() },
        async () =>
          methods().bindConnectorInstallationToMCPServer({
            installationId: String(installation._id),
            mcpServerId: String(ownedServer._id),
            expectedVersion: 0,
          }),
      ),
    ).resolves.toBeNull();
  });

  it('does not return installations belonging to another tenant', async () => {
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
                provider: 'chatwoot',
        displayName: 'Support',
        visibility: 'personal',
      }),
    );
    const visible = await tenantStorage.run({ tenantId: 'tenant-b', userId: 'user-b' }, async () =>
      methods().listConnectorInstallations(),
    );
    expect(visible).toHaveLength(0);
  });

  it('uses optimistic version checks and enforces lifecycle transitions', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
                provider: 'n8n',
        displayName: 'Automation',
        visibility: 'tenant',
      }),
    );

    const authorizing = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id),
        expectedVersion: 0,
        state: 'authorizing',
      }),
    );
    expect(authorizing?.state).toBe('authorizing');
    expect(authorizing?.version).toBe(1);

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 1,
          state: 'connected',
        }),
      ),
    ).resolves.toMatchObject({ state: 'connected', version: 2 });

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 0,
          state: 'connected',
        }),
      ),
    ).resolves.toBeNull();
  });

  it('rejects invalid lifecycle transitions', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
                provider: 'n8n',
        displayName: 'Automation',
        visibility: 'personal',
      }),
    );
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
        methods().transitionConnectorInstallation({
          installationId: String(created._id),
          expectedVersion: 0,
          state: 'connected',
        }),
      ),
    ).rejects.toThrow('Invalid connector state transition');
  });

  it('persists explicit personal-connector grants with optimistic concurrency', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace',
        displayName: 'Workspace',
        visibility: 'personal',
      }),
    );
    const updated = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'user-a' },
      async () =>
        methods().updateConnectorInstallationGrants({
          installationId: String(created._id),
          expectedVersion: 0,
          principalIds: ['user-b', 'user-b', 'user-c'],
        }),
    );
    expect(updated?.grantedPrincipalIds).toEqual(['user-b', 'user-c']);
    expect(updated?.version).toBe(1);
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
        methods().updateConnectorInstallationGrants({
          installationId: String(created._id),
          expectedVersion: 0,
          principalIds: ['user-d'],
        }),
      ),
    ).resolves.toBeNull();
  });

  it('does not allow another tenant member to change the owner’s personal connector grants', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace',
        displayName: 'Owner workspace',
        visibility: 'personal',
      }),
    );

    const attempted = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'user-b' },
      async () =>
        methods().updateConnectorInstallationGrants({
          installationId: String(created._id),
          expectedVersion: 0,
          principalIds: ['user-b'],
        }),
    );

    expect(attempted).toBeNull();
    const unchanged = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'user-a' },
      async () => methods().getConnectorInstallation(String(created._id)),
    );
    expect(unchanged?.grantedPrincipalIds).toEqual([]);
    expect(unchanged?.version).toBe(0);
  });

  it('does not allow grant changes after an installation is revoked', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace',
        displayName: 'Revoked workspace',
        visibility: 'personal',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().revokeConnectorInstallation(String(created._id)),
    );

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
        methods().updateConnectorInstallationGrants({
          installationId: String(created._id),
          expectedVersion: 1,
          principalIds: ['user-b'],
        }),
      ),
    ).resolves.toBeNull();
  });

  it('refuses unscoped creation even when global tenant strict mode is disabled', async () => {
    await expect(
      methods().createConnectorInstallation({
                provider: 'google-workspace',
        displayName: 'Google Workspace',
        visibility: 'personal',
      }),
    ).rejects.toThrow('requires an active tenant context');
  });

  it('revokes an installation and removes its credential reference', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
                provider: 'chatwoot',
        displayName: 'Support',
        visibility: 'personal',
        credentialRef: 'vault-ref-456',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      mongoose.models.ConnectorCredential.create({
        installationId: String(created._id),
        ownerUserId: 'user-a',
        provider: 'chatwoot',
        encryptedPayload: 'encrypted-only-test-payload',
        keyVersion: 'gcm1',
      }),
    );
    const revoked = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().revokeConnectorInstallation(String(created._id)),
    );
    expect(revoked).toBe(true);
    const stored = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      mongoose.models.ConnectorInstallation.findById(created._id)
        .select('+credentialRef')
        .lean(),
    );
    expect(stored?.state).toBe('revoked');
    expect(stored?.credentialRef).toBeNull();
    const credentialCount = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'user-a' },
      async () =>
        mongoose.models.ConnectorCredential.countDocuments({
          installationId: String(created._id),
        }),
    );
    expect(credentialCount).toBe(0);
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

  it('marks a connected installation degraded only after the configured consecutive failure threshold', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace',
        displayName: 'Health monitored workspace',
        visibility: 'personal',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id), expectedVersion: 0, state: 'authorizing',
      }),
    );
    const connected = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id), expectedVersion: 1, state: 'connected',
      }),
    );
    expect(connected?.state).toBe('connected');

    const first = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().recordConnectorHealth({
        installationId: String(created._id), expectedHealthVersion: 0,
        outcome: 'unhealthy', errorCode: 'google_provider_unavailable', failureThreshold: 2,
      }),
    );
    expect(first).toMatchObject({ state: 'connected', consecutiveHealthFailures: 1, healthVersion: 1, version: 2 });

    const second = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().recordConnectorHealth({
        installationId: String(created._id), expectedHealthVersion: 1,
        outcome: 'unhealthy', errorCode: 'google_provider_unavailable', failureThreshold: 2,
      }),
    );
    expect(second).toMatchObject({ state: 'degraded', consecutiveHealthFailures: 2, healthVersion: 2, version: 2 });
    expect(second?.lastErrorCode).toBe('google_provider_unavailable');
  });

  it('recovers a degraded installation after a successful health observation', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace', displayName: 'Recoverable workspace', visibility: 'personal',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id), expectedVersion: 0, state: 'authorizing',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().transitionConnectorInstallation({
        installationId: String(created._id), expectedVersion: 1, state: 'connected',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().recordConnectorHealth({
        installationId: String(created._id), expectedHealthVersion: 0,
        outcome: 'unhealthy', errorCode: 'google_provider_unavailable', failureThreshold: 1,
      }),
    );
    const recovered = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().recordConnectorHealth({
        installationId: String(created._id), expectedHealthVersion: 1, outcome: 'healthy',
      }),
    );
    expect(recovered).toMatchObject({
      state: 'connected', consecutiveHealthFailures: 0, healthVersion: 2, version: 3,
    });
    expect(recovered?.lastErrorCode).toBeNull();
    expect(recovered?.lastSuccessfulHealthCheckAt).toBeInstanceOf(Date);
  });

  it('does not allow health probes to revive revoked installations or overwrite stale versions', async () => {
    const created = await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().createConnectorInstallation({
        provider: 'google-workspace', displayName: 'Revoked workspace', visibility: 'personal',
      }),
    );
    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().revokeConnectorInstallation(String(created._id)),
    );
    await expect(tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, async () =>
      methods().recordConnectorHealth({
        installationId: String(created._id), expectedHealthVersion: 0, outcome: 'healthy',
      }),
    )).resolves.toBeNull();
  });


});
