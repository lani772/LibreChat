import { ConnectorHealthMonitor } from './ConnectorHealthMonitor';

const id = '507f1f77bcf86cd799439011';
function installation(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => id },
    provider: 'google-workspace',
    state: 'connected' as const,
    version: 4,
    healthVersion: 2,
    consecutiveHealthFailures: 0,
    lastErrorCode: undefined,
    ...overrides,
  };
}

describe('ConnectorHealthMonitor', () => {
  it('records a successful provider probe without exposing provider data', async () => {
    const recordConnectorHealth = jest.fn().mockResolvedValue({
      ...installation(), healthVersion: 3, lastSuccessfulHealthCheckAt: new Date(),
    });
    const store = {
      getConnectorInstallation: jest.fn().mockResolvedValue(installation()),
      listConnectorHealthCandidates: jest.fn().mockResolvedValue([]),
      recordConnectorHealth,
    };
    const probe = jest.fn().mockResolvedValue(undefined);
    const monitor = new ConnectorHealthMonitor(store, { 'google-workspace': probe }, {
      now: () => new Date('2026-11-10T00:00:00.000Z'),
    });
    await expect(monitor.checkInstallation(id)).resolves.toMatchObject({
      status: 'healthy', state: 'connected', consecutiveFailures: 0, errorCode: null,
    });
    expect(recordConnectorHealth).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'healthy', expectedHealthVersion: 2,
      checkedAt: new Date('2026-11-10T00:00:00.000Z'),
    }));
  });

  it('maps provider failures to safe codes and does not leak provider error messages', async () => {
    const recordConnectorHealth = jest.fn().mockResolvedValue({
      ...installation(), healthVersion: 3, lastErrorCode: 'provider_unavailable',
      consecutiveHealthFailures: 1,
    });
    const store = {
      getConnectorInstallation: jest.fn().mockResolvedValue(installation()),
      listConnectorHealthCandidates: jest.fn().mockResolvedValue([]),
      recordConnectorHealth,
    };
    const monitor = new ConnectorHealthMonitor(store, {
      'google-workspace': async () => {
        throw Object.assign(new Error('private response body and token'), { code: 'PROVIDER_UNAVAILABLE' });
      },
    });
    const result = await monitor.checkInstallation(id);
    expect(result).toMatchObject({
      status: 'unhealthy', errorCode: 'provider_unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('private response body');
    expect(recordConnectorHealth).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'unhealthy', errorCode: 'provider_unavailable',
    }));
  });

  it('skips disconnected installations and stale compare-and-set observations', async () => {
    const store = {
      getConnectorInstallation: jest.fn().mockResolvedValueOnce(installation({ state: 'disconnected' }))
        .mockResolvedValueOnce(installation()),
      listConnectorInstallations: jest.fn().mockResolvedValue([]),
      recordConnectorHealth: jest.fn().mockResolvedValue(null),
    };
    const monitor = new ConnectorHealthMonitor(store, { 'google-workspace': jest.fn() });
    await expect(monitor.checkInstallation(id)).resolves.toMatchObject({ status: 'skipped' });
    await expect(monitor.checkInstallation(id)).resolves.toMatchObject({ status: 'stale' });
  });

  it('bounds health batches', async () => {
    const store = {
      getConnectorInstallation: jest.fn(),
      listConnectorInstallations: jest.fn().mockResolvedValue([]),
      recordConnectorHealth: jest.fn(),
    };
    const monitor = new ConnectorHealthMonitor(store, {});
    await expect(monitor.checkBatch(26)).rejects.toThrow('between 1 and 25');
    await expect(monitor.checkBatch(5)).resolves.toMatchObject({ checked: 0, healthy: 0 });
  });
});
