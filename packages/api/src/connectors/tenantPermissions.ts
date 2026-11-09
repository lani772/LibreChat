import { PermissionTypes, Permissions } from 'librechat-data-provider';

type ConnectorPrincipalRecord = {
  tenantId?: string;
  role?: string;
};

type ConnectorRoleRecord = {
  permissions?: {
    [PermissionTypes.MCP_SERVERS]?: {
      [Permissions.USE]?: boolean;
    };
  };
};

export type TenantConnectorPermissionDependencies = {
  getUserById: (
    principalId: string,
    fieldsToSelect: string[],
  ) => Promise<ConnectorPrincipalRecord | null>;
  /** Must read the role from the active tenant partition and bypass shared role caches. */
  getPartitionRole: (roleName: string) => Promise<ConnectorRoleRecord | null>;
};

/**
 * Resolve tenant-shared connector access from LibreChat's existing tenant role.
 *
 * MCP-backed connectors use the existing MCP_SERVERS.USE role permission: it is
 * already exposed by the role editor and represents permission to consume MCP
 * servers. Reads are performed for every authorization check so role changes
 * take effect without waiting for a permission cache to expire.
 */
export function createTenantConnectorPermissionResolver({
  getUserById,
  getPartitionRole,
}: TenantConnectorPermissionDependencies) {
  return async ({
    tenantId,
    principalId,
  }: {
    tenantId: string;
    principalId: string;
  }): Promise<{ isTenantMember: boolean; canInvokeTenantConnector: boolean }> => {
    const principal = await getUserById(principalId, ['tenantId', 'role']);
    const isTenantMember = principal?.tenantId === tenantId;

    if (!isTenantMember || typeof principal?.role !== 'string' || !principal.role.trim()) {
      return { isTenantMember: false, canInvokeTenantConnector: false };
    }

    const role = await getPartitionRole(principal.role);
    const canInvokeTenantConnector =
      role?.permissions?.[PermissionTypes.MCP_SERVERS]?.[Permissions.USE] === true;

    return { isTenantMember: true, canInvokeTenantConnector };
  };
}
