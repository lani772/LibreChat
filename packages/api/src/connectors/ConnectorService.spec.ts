import { tenantStorage } from '@librechat/data-schemas';
import type { ConnectorInstallationDocument } from '@librechat/data-schemas';
import { ConnectorAccessError, ConnectorService } from './ConnectorService';

const installation = (overrides: Partial<ConnectorInstallationDocument> = {}) =>
  ({
    _id: '507f1f77bcf86cd799439011',
    tenantId: 'tenant-a',
    ownerUserId: 'user-a',
    provider: 'google-workspace',
    instanceKey: 'instance-a',
    displayName: 'Workspace',
    visibility: 'personal',
    state: 'connected',
    grantedPrincipalIds: [],
    version: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as ConnectorInstallationDocument;

function setup({
  principalId = 'user-a',
  tenantId = 'tenant-a',
  record = installation(),
  permissions = { isTenantMember: true, canInvokeTenantConnector: true },
  permissionFailure = false,
}: {
  principalId?: string;
  tenantId?: string;
  record?: ConnectorInstallationDocument | null;
  permissions?: { isTenantMember: boolean; canInvokeTenantConnector: boolean };
  permissionFailure?: boolean;
} = {}) {
  const audit = jest.fn().mockResolvedValue(undefined);
  const getConnectorInstallation = jest.fn().mockResolvedValue(record);
  const resolvePrincipalPermissions = jest.fn().mockImplementation(async () => {
    if (permissionFailure) throw new Error('membership store unavailable');
    return permissions;
  });
  const service = new ConnectorService({
    installations: { getConnectorInstallation },
    resolvePrincipalPermissions,
    audit,
  });
  return {
    service, audit, getConnectorInstallation, resolvePrincipalPermissions,
    run: <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId, userId: principalId }, fn),
  };
}

describe('ConnectorService', () => {
  it('uses trusted tenant and user context', async () => {
    const test = setup();
    const result = await test.run(() => test.service.authorize('installation-id'));
    expect(result.principalId).toBe('user-a');
    expect(result.tenantId).toBe('tenant-a');
    expect(test.resolvePrincipalPermissions).toHaveBeenCalledWith({
      tenantId: 'tenant-a', principalId: 'user-a',
    });
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'allowed', provider: 'google-workspace' }),
    );
  });

  it('does not invoke provider callback for an unauthorized personal connector', async () => {
    const test = setup({ principalId: 'user-b', record: installation({ ownerUserId: 'user-a' }) });
    const operation = jest.fn();
    await expect(test.run(() => test.service.execute('installation-id', operation)))
      .rejects.toBeInstanceOf(ConnectorAccessError);
    expect(operation).not.toHaveBeenCalled();
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied', reason: 'not_owner_or_granted' }),
    );
  });

  it('does not expose a credential reference to the provider callback', async () => {
    const test = setup({ record: installation({ credentialRef: 'vault-secret-pointer' }) });
    const result = await test.run(() => test.service.authorize('installation-id'));
    expect(result.installation).not.toHaveProperty('credentialRef');
  });

  it('fails closed when the permission resolver returns incomplete data', async () => {
    const service = new ConnectorService({
      installations: { getConnectorInstallation: jest.fn().mockResolvedValue(installation()) },
      resolvePrincipalPermissions: jest.fn().mockResolvedValue({ isTenantMember: true }),
      audit: jest.fn().mockResolvedValue(undefined),
    });
    await expect(tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, () =>
      service.authorize('installation-id'),
    )).rejects.toBeInstanceOf(ConnectorAccessError);
  });

  it('allows an explicitly granted principal', async () => {
    const test = setup({
      principalId: 'user-b',
      record: installation({ ownerUserId: 'user-a', grantedPrincipalIds: ['user-b'] }),
    });
    const value = await test.run(() => test.service.execute('installation-id', async () => 'called'));
    expect(value).toBe('called');
  });

  it('denies cross-tenant access', async () => {
    const test = setup({ record: installation({ tenantId: 'tenant-b' }) });
    await expect(test.run(() => test.service.authorize('installation-id')))
      .rejects.toBeInstanceOf(ConnectorAccessError);
  });

  it('fails closed when membership lookup fails', async () => {
    const test = setup({ permissionFailure: true });
    await expect(test.run(() => test.service.authorize('installation-id')))
      .rejects.toBeInstanceOf(ConnectorAccessError);
    expect(test.audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'denied', reason: 'permission_lookup_failed' }),
    );
  });

  it('fails closed when the installation is missing', async () => {
    const test = setup({ record: null });
    await expect(test.run(() => test.service.authorize('missing')))
      .rejects.toBeInstanceOf(ConnectorAccessError);
    expect(test.resolvePrincipalPermissions).not.toHaveBeenCalled();
  });

  it('fails closed without trusted identity context', async () => {
    const test = setup();
    await expect(test.service.authorize('installation-id')).rejects.toBeInstanceOf(ConnectorAccessError);
    expect(test.getConnectorInstallation).not.toHaveBeenCalled();
  });

  it('fails closed if audit persistence fails', async () => {
    const audit = jest.fn().mockRejectedValue(new Error('audit unavailable'));
    const service = new ConnectorService({
      installations: { getConnectorInstallation: jest.fn().mockResolvedValue(installation()) },
      resolvePrincipalPermissions: jest.fn().mockResolvedValue({
        isTenantMember: true, canInvokeTenantConnector: true,
      }),
      audit,
    });
    await expect(tenantStorage.run({ tenantId: 'tenant-a', userId: 'user-a' }, () =>
      service.authorize('installation-id'),
    )).rejects.toBeInstanceOf(ConnectorAccessError);
  });
});
