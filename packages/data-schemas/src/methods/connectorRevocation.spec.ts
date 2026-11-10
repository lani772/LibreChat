import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createConnectorInstallationModel } from '~/models/connectorInstallation';
import { createConnectorRevocationModel } from '~/models/connectorRevocation';
import { createConnectorRevocationMethods } from './connectorRevocation';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createConnectorInstallationModel(mongoose);
  createConnectorRevocationModel(mongoose);
  await mongoose.models.ConnectorRevocation.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('Google Workspace revocation outbox persistence', () => {
  const methods = () => createConnectorRevocationMethods(mongoose);

  beforeEach(async () => {
    await mongoose.models.ConnectorRevocation.deleteMany({});
    await mongoose.models.ConnectorInstallation.deleteMany({});
  });

  async function createInstallation(tenantId = 'tenant-a', userId = 'owner-a') {
    return tenantStorage.run({ tenantId, userId }, async () =>
      mongoose.models.ConnectorInstallation.create({
        ownerUserId: userId,
        provider: 'google-workspace',
        instanceKey: `instance-${tenantId}`,
        displayName: 'Workspace',
        visibility: 'personal',
        state: 'connected',
        grantedPrincipalIds: [],
        version: 1,
      }),
    );
  }

  async function enqueue(installationId: string, tenantId = 'tenant-a', userId = 'owner-a') {
    return tenantStorage.run({ tenantId, userId }, () =>
      methods().enqueueGoogleWorkspaceRevocation({
        installationId,
        encryptedPayload: JSON.stringify({ version: 'gcm1', ciphertext: 'encrypted-only' }),
      }),
    );
  }

  it('enqueues idempotently for the authenticated installation owner', async () => {
    const installation = await createInstallation();
    const first = await enqueue(String(installation._id));
    const second = await enqueue(String(installation._id));
    expect(second).toEqual(first);
    expect(first.state).toBe('pending');

    const ordinary = await tenantStorage.run(
      { tenantId: 'tenant-a', userId: 'owner-a' },
      async () => mongoose.models.ConnectorRevocation.findById(first.id).lean(),
    );
    expect(ordinary?.encryptedPayload).toBeUndefined();
  });

  it('rejects another owner and a cross-tenant principal', async () => {
    const installation = await createInstallation();
    await expect(enqueue(String(installation._id), 'tenant-a', 'attacker')).rejects.toThrow(
      'unavailable',
    );
    await expect(enqueue(String(installation._id), 'tenant-b', 'owner-a')).rejects.toThrow(
      'unavailable',
    );
  });

  it('requires system context and grants only one live worker lease', async () => {
    const installation = await createInstallation();
    const job = await enqueue(String(installation._id));
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().claimGoogleWorkspaceRevocation({
          leaseToken: 'tenant-worker',
          leaseUntil: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toThrow('explicit system context');

    const first = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'worker-one',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    const second = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'worker-two',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(first).toMatchObject({ id: job.id, leaseToken: 'worker-one', attempts: 1 });
    expect(first?.encryptedPayload).toContain('encrypted-only');
    expect(second).toBeNull();
  });

  it('does not consider a job ready until its installation is locally revoked', async () => {
    const installation = await createInstallation();
    await enqueue(String(installation._id));
    const before = await runAsSystem(async () =>
      methods().isConnectorInstallationRevokedForSystem({
        tenantId: 'tenant-a',
        installationId: String(installation._id),
      }),
    );
    expect(before).toBe(false);

    await tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, async () => {
      await mongoose.models.ConnectorInstallation.updateOne(
        { _id: installation._id },
        { $set: { state: 'revoked' } },
      );
    });
    const after = await runAsSystem(async () =>
      methods().isConnectorInstallationRevokedForSystem({
        tenantId: 'tenant-a',
        installationId: String(installation._id),
      }),
    );
    expect(after).toBe(true);
  });

  it('completes only with the active lease and clears encrypted payload', async () => {
    const installation = await createInstallation();
    const job = await enqueue(String(installation._id));
    const claimed = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'worker-current',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(claimed?.id).toBe(job.id);

    const stale = await runAsSystem(async () =>
      methods().completeGoogleWorkspaceRevocation({ id: job.id, leaseToken: 'stale' }),
    );
    expect(stale).toBe(false);
    const completed = await runAsSystem(async () =>
      methods().completeGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: 'worker-current',
      }),
    );
    expect(completed).toBe(true);
    const stored = await runAsSystem(async () =>
      mongoose.models.ConnectorRevocation.findById(job.id)
        .select('+encryptedPayload')
        .lean(),
    );
    expect(stored?.state).toBe('complete');
    expect(stored?.encryptedPayload).toBeNull();
  });

  it('lists dead letters without returning encrypted payloads and requeues only in system context', async () => {
    const installation = await createInstallation();
    const job = await enqueue(String(installation._id));
    await runAsSystem(async () => {
      await methods().retryGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: 'no-lease-yet',
        nextAttemptAt: new Date(),
        errorCode: 'forced_test_failure',
        maxAttempts: 1,
      }).catch(() => 'lost');
    });
    const claimed = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'dead-letter-worker',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(claimed?.id).toBe(job.id);
    await runAsSystem(async () =>
      methods().retryGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: 'dead-letter-worker',
        nextAttemptAt: new Date(Date.now() + 60_000),
        errorCode: 'remote_revocation_failed',
        maxAttempts: 1,
      }),
    );

    const dead = await runAsSystem(async () =>
      methods().listGoogleWorkspaceRevocationDeadLetters({ limit: 10 }),
    );
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      id: job.id,
      installationId: String(installation._id),
      attempts: 1,
      lastErrorCode: 'remote_revocation_failed',
    });
    expect(dead[0]).not.toHaveProperty('encryptedPayload');

    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().requeueGoogleWorkspaceRevocationDeadLetter({ id: job.id }),
      ),
    ).rejects.toThrow('explicit system context');
    const requeued = await runAsSystem(async () =>
      methods().requeueGoogleWorkspaceRevocationDeadLetter({ id: job.id }),
    );
    expect(requeued).toBe(true);
    const nextClaim = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'retry-worker',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(nextClaim?.id).toBe(job.id);
    expect(nextClaim?.attempts).toBe(1);
  });

  it('reschedules failures and moves exhausted jobs to dead state', async () => {
    const installation = await createInstallation();
    const job = await enqueue(String(installation._id));
    const claimed = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'worker-attempt-one',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(claimed?.id).toBe(job.id);

    const dead = await runAsSystem(async () =>
      methods().retryGoogleWorkspaceRevocation({
        id: job.id,
        leaseToken: 'worker-attempt-one',
        nextAttemptAt: new Date(Date.now() + 60_000),
        errorCode: 'remote_revocation_failed',
        maxAttempts: 1,
      }),
    );
    expect(dead).toBe('dead');
    const nextClaim = await runAsSystem(async () =>
      methods().claimGoogleWorkspaceRevocation({
        leaseToken: 'worker-attempt-two',
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    );
    expect(nextClaim).toBeNull();
  });
  it('allows only system context to scan and compare-and-set rotation of encrypted outbox payloads', async () => {
    const installation = await createInstallation();
    await enqueue(String(installation._id));
    await expect(
      tenantStorage.run({ tenantId: 'tenant-a', userId: 'owner-a' }, () =>
        methods().listConnectorRevocationsForRotation({ limit: 10 }),
      ),
    ).rejects.toThrow('explicit system context');

    const [record] = await runAsSystem(async () =>
      methods().listConnectorRevocationsForRotation({ limit: 10 }),
    );
    expect(record).toBeDefined();
    expect(record.encryptedPayload).toContain('encrypted-only');
    const updated = await runAsSystem(async () =>
      methods().replaceConnectorRevocationForRotation({
        id: record.id,
        tenantId: record.tenantId,
        expectedEncryptedPayload: record.encryptedPayload,
        expectedUpdatedAt: record.updatedAt,
        encryptedPayload: 'rotated-envelope',
      }),
    );
    expect(updated).toBe(true);
    const [after] = await runAsSystem(async () =>
      methods().listConnectorRevocationsForRotation({ limit: 10 }),
    );
    expect(after.encryptedPayload).toBe('rotated-envelope');

    const stale = await runAsSystem(async () =>
      methods().replaceConnectorRevocationForRotation({
        id: record.id,
        tenantId: record.tenantId,
        expectedEncryptedPayload: record.encryptedPayload,
        expectedUpdatedAt: record.updatedAt,
        encryptedPayload: 'stale-envelope',
      }),
    );
    expect(stale).toBe(false);
  });

});
