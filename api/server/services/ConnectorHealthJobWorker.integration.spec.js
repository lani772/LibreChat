const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/api', () => ({
  ConnectorHealthRetryPolicy: class {
    decide() {
      return { retry: false, errorCode: 'test_terminal_error' };
    }
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  tenantStorage: {
    run: (_identity, operation) => operation(),
  },
  getTenantId: () => 'tenant-a',
  getUserId: () => 'owner-a',
  runAsSystem: (operation) => operation(),
}));

describe('ConnectorHealthJobWorker MongoDB concurrency integration', () => {
  let mongo;
  let worker;
  let HealthJob;
  let replicaConnection;
  let ReplicaHealthJob;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'connector-health-worker-test' });
    // Load after connecting so the worker's index initialization targets this database.
    worker = require('./ConnectorHealthJobWorker');
    HealthJob = mongoose.models.ConnectorHealthJob;
    await HealthJob.init();
    // A second independent Mongoose connection models a second worker replica.
    replicaConnection = await mongoose.createConnection(mongo.getUri(), {
      dbName: 'connector-health-worker-test',
    }).asPromise();
    ReplicaHealthJob = replicaConnection.model('ConnectorHealthJob', HealthJob.schema);
    await ReplicaHealthJob.init();
  }, 120_000);

  afterAll(async () => {
    await replicaConnection?.close();
    await mongoose.disconnect();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await HealthJob.deleteMany({});
  });

  const createPendingJob = (overrides = {}) => HealthJob.create({
    tenantId: 'tenant-a',
    ownerUserId: 'owner-a',
    installationId: '507f1f77bcf86cd799439011',
    provider: 'google-workspace',
    status: 'pending',
    attempt: 0,
    nextAttemptAt: new Date(Date.now() - 1_000),
    fence: 0,
    activeKey: 'tenant-a:owner-a:507f1f77bcf86cd799439011',
    ...overrides,
  });

  it('allows only one replica to claim a due job', async () => {
    await createPendingJob();

    const claims = await Promise.all([worker.claimJob(), worker.claimJob({ model: ReplicaHealthJob })]);
    const winners = claims.filter(Boolean);

    expect(winners).toHaveLength(1);
    expect(winners[0].status).toBe('processing');
    expect(winners[0].fence).toBe(1);

    const persisted = await HealthJob.findById(winners[0]._id).lean();
    expect(persisted.status).toBe('processing');
    expect(persisted.leaseToken).toBe(winners[0].leaseToken);
  });

  it('reclaims an expired lease once, increments its fence and rejects stale renewal', async () => {
    const original = await createPendingJob({
      status: 'processing',
      leaseToken: 'replica-one-token',
      leaseUntil: new Date(Date.now() - 5_000),
      fence: 4,
    });

    const claims = await Promise.all([worker.claimJob(), worker.claimJob({ model: ReplicaHealthJob })]);
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].fence).toBe(5);
    expect(winners[0].leaseToken).not.toBe('replica-one-token');
    expect(winners[0].auditOutbox).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'connector.health_job_lease_recovered',
        metadata: expect.objectContaining({
          recovery: 'expired_lease',
          previousFence: '4',
        }),
      }),
    ]));

    await expect(worker.renewClaim({
      _id: original._id,
      leaseToken: 'replica-one-token',
      fence: 4,
    })).resolves.toBe(false);
  });

  it('delivers a durable audit event left behind by a crashed worker after restart', async () => {
    const event = {
      eventId: 'crash-recovery-event-1',
      action: 'connector.health_job_retry_scheduled',
      outcome: 'pending',
      severity: 'warning',
      metadata: { attempt: 3, source: 'worker_exception' },
      createdAt: new Date(),
    };
    const job = await createPendingJob({
      auditOutbox: [event],
    });
    // Simulate a new process/replica starting after the original worker exited
    // without acknowledging its durable audit outbox record.
    const auditDb = { recordAuditEntry: jest.fn().mockResolvedValue({}) };

    await worker.flushHealthJobAuditOutbox(job._id, auditDb);

    expect(auditDb.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        metadata: expect.objectContaining({
          eventId: 'crash-recovery-event-1',
          jobId: job._id.toString(),
          attempt: 3,
        }),
      }),
      { failClosed: true },
    );
    const persisted = await HealthJob.findById(job._id).lean();
    expect(persisted.auditOutbox).toHaveLength(0);
  });

  it('keeps active-job uniqueness partitioned by tenant and owner', async () => {
    await createPendingJob();
    await expect(createPendingJob()).rejects.toMatchObject({ code: 11000 });

    await expect(createPendingJob({
      tenantId: 'tenant-b',
      activeKey: 'tenant-b:owner-a:507f1f77bcf86cd799439011',
    })).resolves.toBeDefined();
    await expect(createPendingJob({
      tenantId: 'tenant-a',
      ownerUserId: 'owner-b',
      activeKey: 'tenant-a:owner-b:507f1f77bcf86cd799439011',
    })).resolves.toBeDefined();
    expect(await HealthJob.countDocuments({})).toBe(3);
  });

  it('prevents a stale worker from committing a probe result after a successor claims the job', async () => {
    const storedJob = await createPendingJob({
      status: 'processing',
      leaseToken: 'replica-one-token',
      leaseUntil: new Date(Date.now() + 60_000),
      fence: 2,
    });
    const job = storedJob.toObject();
    const monitor = {
      checkInstallation: jest.fn(async () => {
        await ReplicaHealthJob.updateOne(
          { _id: job._id, status: 'processing', leaseToken: 'replica-one-token', fence: 2 },
          {
            $set: { leaseToken: 'replica-two-token', leaseUntil: new Date(Date.now() + 60_000) },
            $inc: { fence: 1 },
          },
        );
        return { status: 'healthy' };
      }),
    };
    const db = {
      getConnectorInstallation: jest.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        ownerUserId: 'owner-a',
        provider: 'google-workspace',
        state: 'connected',
      }),
    };

    await worker.processClaim(job, monitor, db);

    const persisted = await HealthJob.findById(job._id).lean();
    expect(monitor.checkInstallation).toHaveBeenCalledTimes(1);
    expect(persisted.status).toBe('processing');
    expect(persisted.leaseToken).toBe('replica-two-token');
    expect(persisted.fence).toBe(3);
  });

  it('rejects an installation owned by a different user in the same tenant', async () => {
    const storedJob = await createPendingJob({
      status: 'processing',
      leaseToken: 'current-token',
      leaseUntil: new Date(Date.now() + 60_000),
      fence: 2,
    });
    const job = storedJob.toObject();
    const monitor = { checkInstallation: jest.fn() };
    const db = {
      getConnectorInstallation: jest.fn().mockResolvedValue({
        tenantId: 'tenant-a',
        ownerUserId: 'owner-b',
        provider: 'google-workspace',
        state: 'connected',
      }),
    };

    await worker.processClaim(job, monitor, db);

    expect(monitor.checkInstallation).not.toHaveBeenCalled();
    const persisted = await HealthJob.findById(job._id).lean();
    expect(persisted.status).toBe('completed');
    expect(persisted.lastErrorCode).toBe('installation_not_eligible');
  });

  it('does not probe an installation whose persisted owner or tenant differs from the job', async () => {
    const storedJob = await createPendingJob({
      status: 'processing',
      leaseToken: 'current-token',
      leaseUntil: new Date(Date.now() + 60_000),
      fence: 2,
    });
    const job = storedJob.toObject();
    const monitor = { checkInstallation: jest.fn() };
    const db = {
      getConnectorInstallation: jest.fn().mockResolvedValue({
        tenantId: 'tenant-b',
        ownerUserId: 'owner-a',
        provider: 'google-workspace',
        state: 'connected',
      }),
    };

    await worker.processClaim(job, monitor, db);

    expect(db.getConnectorInstallation).toHaveBeenCalledWith(job.installationId);
    expect(monitor.checkInstallation).not.toHaveBeenCalled();
    const persisted = await HealthJob.findById(job._id).lean();
    expect(persisted.status).toBe('completed');
    expect(persisted.lastErrorCode).toBe('installation_not_eligible');
    expect(persisted.activeKey).toBeUndefined();
  });
});
