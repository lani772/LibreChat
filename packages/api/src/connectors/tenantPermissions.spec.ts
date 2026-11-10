import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { createTenantConnectorPermissionResolver } from './tenantPermissions';

const tenantId = 'tenant-a';
const principalId = 'user-a';

function makeResolver({
  principal = { tenantId, role: 'MEMBER' },
  permission = true,
}: {
  principal?: { tenantId?: string; role?: string } | null;
  permission?: boolean | undefined;
} = {}) {
  const getUserById = jest.fn().mockResolvedValue(principal);
  const getPartitionRole = jest.fn().mockResolvedValue(
    permission === undefined
      ? { permissions: {} }
      : { permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.INVOKE_CONNECTORS]: permission } } },
  );
  return {
    resolve: createTenantConnectorPermissionResolver({ getUserById, getPartitionRole }),
    getUserById,
    getPartitionRole,
  };
}

describe('tenant connector role permission resolver', () => {
  it('allows a tenant member whose current tenant role permits connector invocation', async () => {
    const { resolve, getUserById, getPartitionRole } = makeResolver();
    await expect(resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: true,
      canInvokeTenantConnector: true,
    });
    expect(getUserById).toHaveBeenCalledWith(principalId, ['tenantId', 'role']);
    expect(getPartitionRole).toHaveBeenCalledWith('MEMBER');
  });

  it('denies a member whose role does not grant connector invocation', async () => {
    const { resolve } = makeResolver({ permission: false });
    await expect(resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: true,
      canInvokeTenantConnector: false,
    });
  });

  it('denies missing connector permission even when general MCP use is enabled', async () => {
    const resolve = createTenantConnectorPermissionResolver({
      getUserById: async () => ({ tenantId, role: 'MEMBER' }),
      getPartitionRole: async () => ({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: {
            [Permissions.USE]: true,
          },
        },
      }),
    });
    await expect(resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: true,
      canInvokeTenantConnector: false,
    });
  });

  it('denies malformed permission data', async () => {
    const { resolve } = makeResolver({ permission: undefined });
    await expect(resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: true,
      canInvokeTenantConnector: false,
    });
  });

  it('denies a principal outside the active tenant without reading a role', async () => {
    const { resolve, getPartitionRole } = makeResolver({
      principal: { tenantId: 'tenant-b', role: 'ADMIN' },
    });
    await expect(resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: false,
      canInvokeTenantConnector: false,
    });
    expect(getPartitionRole).not.toHaveBeenCalled();
  });

  it('denies missing users and users without a valid role name', async () => {
    const missing = makeResolver({ principal: null });
    await expect(missing.resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: false,
      canInvokeTenantConnector: false,
    });
    const malformed = makeResolver({ principal: { tenantId, role: '  ' } });
    await expect(malformed.resolve({ tenantId, principalId })).resolves.toEqual({
      isTenantMember: false,
      canInvokeTenantConnector: false,
    });
    expect(malformed.getPartitionRole).not.toHaveBeenCalled();
  });

  it('does not swallow authoritative lookup failures', async () => {
    const { resolve } = makeResolver();
    const failure = new Error('role store unavailable');
    // The service boundary treats this rejected resolver as an authorization failure.
    const failingResolver = createTenantConnectorPermissionResolver({
      getUserById: async () => ({ tenantId, role: 'MEMBER' }),
      getPartitionRole: async () => {
        throw failure;
      },
    });
    await expect(failingResolver({ tenantId, principalId })).rejects.toBe(failure);
    expect(resolve).toBeDefined();
  });

  it('reads the role afresh on every invocation so revocations take effect immediately', async () => {
    const getUserById = jest.fn().mockResolvedValue({ tenantId, role: 'MEMBER' });
    const getPartitionRole = jest
      .fn()
      .mockResolvedValueOnce({
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.INVOKE_CONNECTORS]: true } },
      })
      .mockResolvedValueOnce({
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.INVOKE_CONNECTORS]: false } },
      });
    const resolve = createTenantConnectorPermissionResolver({ getUserById, getPartitionRole });

    await expect(resolve({ tenantId, principalId })).resolves.toMatchObject({
      canInvokeTenantConnector: true,
    });
    await expect(resolve({ tenantId, principalId })).resolves.toMatchObject({
      canInvokeTenantConnector: false,
    });
    expect(getPartitionRole).toHaveBeenCalledTimes(2);
  });
});
