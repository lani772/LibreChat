const mockModel = {
  createIndexes: jest.fn().mockResolvedValue(undefined),
  findOneAndUpdate: jest.fn(() => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ _id: 'job-1' }) }) })),
  findOne: jest.fn(() => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({ _id: 'job-1' }) }) })),
};
let tenantId = 'tenant-a';
let userId = 'owner-a';

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
  getTenantId: () => tenantId,
  getUserId: () => userId,
  runAsSystem: (operation) => operation(),
}));

jest.mock('@librechat/api', () => ({
  ConnectorHealthRetryPolicy: class {
    decide() { return { retry: false, errorCode: 'test' }; }
  },
}));

const { enqueueOwnerHealthCheck } = require('./ConnectorHealthJobWorker');

describe('ConnectorHealthJobWorker enqueue boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tenantId = 'tenant-a';
    userId = 'owner-a';
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
  });

  it('rejects missing or system identity', async () => {
    tenantId = '__SYSTEM__';
    await expect(enqueueOwnerHealthCheck({
      installationId: '507f1f77bcf86cd799439011',
    })).rejects.toThrow('authenticated tenant owner context');
    tenantId = undefined;
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
