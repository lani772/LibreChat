const mockModel = {
  createIndexes: jest.fn().mockResolvedValue(undefined),
  findOneAndUpdate: jest.fn(() => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ _id: 'job-1' }) }) })),
  findOne: jest.fn(() => ({
    select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(null) }) }),
    lean: () => ({ exec: jest.fn().mockResolvedValue(null) }),
  })),
  find: jest.fn(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue([{ _id: 'job-1', status: 'dead', attempt: 5, lastErrorCode: 'google_reauthorization_required' }]) }) }) }) }) })),
};
let mockTenantId = 'tenant-a';
let mockUserId = 'owner-a';

jest.mock('mongoose', () => {
  class Schema {
    index() {}
  }
  return {
    Schema,
    models: {},
    model: jest.fn(() => mockModel),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
  tenantStorage: { run: (_identity, operation) => operation() },
  getTenantId: () => mockTenantId,
  getUserId: () => mockUserId,
  runAsSystem: (operation) => operation(),
}));

jest.mock('~/models', () => ({ recordAuditEntry: jest.fn().mockResolvedValue({}) }));

jest.mock('@librechat/api', () => ({
  ConnectorHealthRetryPolicy: class {
    decide() { return { retry: false, errorCode: 'test' }; }
  },
}));

const { claimJob, enqueueOwnerHealthCheck, listOwnerHealthJobs, retryOwnerDeadHealthJob } = require('./ConnectorHealthJobWorker');

describe('ConnectorHealthJobWorker enqueue boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantId = 'tenant-a';
    mockUserId = 'owner-a';
  });

  it('persists tenant and owner from trusted context, not caller arguments', async () => {
    await enqueueOwnerHealthCheck({
      installationId: '507f1f77bcf86cd799439011',
      provider: 'google-workspace',
      delayMs: 60_000,
      tenantId: 'attacker-tenant',
      ownerUserId: 'attacker-user',
    });
    const [filter, update] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(filter.activeKey).toBe('tenant-a:owner-a:507f1f77bcf86cd799439011');
    expect(update.$setOnInsert).toMatchObject({
      tenantId: 'tenant-a',
      ownerUserId: 'owner-a',
      installationId: '507f1f77bcf86cd799439011',
      provider: 'google-workspace',
      status: 'pending',
    });
    expect(update.$setOnInsert).not.toHaveProperty('attacker-tenant');
    expect(update.$setOnInsert.auditOutbox).toEqual([
      expect.objectContaining({
        action: 'connector.health_job_scheduled',
        outcome: 'pending',
        severity: 'info',
        metadata: { delayMs: 60_000 },
      }),
    ]);
  });

  it('rejects missing or system identity', async () => {
    mockTenantId = '__SYSTEM__';
    await expect(enqueueOwnerHealthCheck({
      installationId: '507f1f77bcf86cd799439011',
    })).rejects.toThrow('authenticated tenant owner context');
    mockTenantId = undefined;
    await expect(enqueueOwnerHealthCheck({
      installationId: '507f1f77bcf86cd799439011',
    })).rejects.toThrow('authenticated tenant owner context');
    expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects malformed installation IDs and unsupported providers', async () => {
    await expect(enqueueOwnerHealthCheck({ installationId: 'not-an-id' })).rejects.toThrow();
    await expect(enqueueOwnerHealthCheck({
      installationId: '507f1f77bcf86cd799439011',
      provider: 'other-provider',
    })).rejects.toThrow();
    expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ConnectorHealthJobWorker owner visibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantId = 'tenant-a';
    mockUserId = 'owner-a';
  });

  it('returns only the safe operational projection for the trusted owner', async () => {
    const jobs = await listOwnerHealthJobs({
      installationId: '507f1f77bcf86cd799439011',
      limit: 10,
    });
    expect(mockModel.find).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      ownerUserId: 'owner-a',
      installationId: '507f1f77bcf86cd799439011',
    });
    expect(jobs[0]).toMatchObject({
      status: 'dead',
      attempt: 5,
      lastErrorCode: 'google_reauthorization_required',
    });
    expect(jobs[0]).not.toHaveProperty('tenantId');
    expect(jobs[0]).not.toHaveProperty('ownerUserId');
    expect(jobs[0]).not.toHaveProperty('leaseToken');
  });

  it('rejects system identity and unbounded limits', async () => {
    mockTenantId = '__SYSTEM__';
    await expect(listOwnerHealthJobs({ installationId: '507f1f77bcf86cd799439011' }))
      .rejects.toThrow('authenticated tenant owner context');
    mockTenantId = 'tenant-a';
    await expect(listOwnerHealthJobs({ installationId: '507f1f77bcf86cd799439011', limit: 1000 }))
      .rejects.toThrow('Invalid connector health job query');
    expect(mockModel.find).not.toHaveBeenCalled();
  });
});

describe('ConnectorHealthJobWorker dead-job recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantId = 'tenant-a';
    mockUserId = 'owner-a';
  });

  it('requeues only a dead job owned by the trusted tenant principal', async () => {
    const result = await retryOwnerDeadHealthJob({
      installationId: '507f1f77bcf86cd799439011',
      jobId: '507f1f77bcf86cd799439012',
    });
    const [filter, update] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: '507f1f77bcf86cd799439012',
      tenantId: 'tenant-a',
      ownerUserId: 'owner-a',
      installationId: '507f1f77bcf86cd799439011',
      status: 'dead',
      provider: 'google-workspace',
    });
    expect(update.$set).toMatchObject({
      status: 'pending',
      attempt: 0,
      activeKey: 'tenant-a:owner-a:507f1f77bcf86cd799439011',
      lastErrorCode: null,
    });
    expect(update.$push.auditOutbox).toMatchObject({
      action: 'connector.health_job_scheduled',
      metadata: { source: 'owner_dead_job_recovery' },
    });
    expect(result).toMatchObject({ id: 'job-1' });
  });

  it('rejects replay without trusted identity and does not touch storage', async () => {
    mockTenantId = '__SYSTEM__';
    await expect(retryOwnerDeadHealthJob({
      installationId: '507f1f77bcf86cd799439011',
      jobId: '507f1f77bcf86cd799439012',
    })).rejects.toThrow('authenticated tenant owner context');
    expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ConnectorHealthJobWorker lease recovery claim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTenantId = 'tenant-a';
    mockUserId = 'owner-a';
  });

  it('atomically fences an expired lease and appends a durable recovery event', async () => {
    await claimJob();
    const [filter, pipeline, options] = mockModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ status: 'processing', leaseUntil: { $lte: expect.any(Date) } });
    expect(Array.isArray(pipeline)).toBe(true);
    expect(pipeline[0].$set.fence).toEqual({ $add: ['$fence', 1] });
    expect(pipeline[0].$set.auditOutbox.$concatArrays[1][0]).toMatchObject({
      action: 'connector.health_job_lease_recovered',
      outcome: 'pending',
      severity: 'warning',
    });
    expect(options).toMatchObject({ new: true });
  });
});
