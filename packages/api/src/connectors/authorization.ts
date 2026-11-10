/**
 * Pure connector authorization policy.
 *
 * Callers must build the context from authenticated server identity and the
 * active tenant context. Never populate it from model-controlled tool input.
 * This module deliberately performs no database or credential operations.
 */
export type ConnectorVisibility = 'personal' | 'tenant';

export type ConnectorInstallationState =
  | 'disconnected'
  | 'authorizing'
  | 'connected'
  | 'degraded'
  | 'revoked'
  | 'error';

export interface ConnectorAccessContext {
  /** Authenticated principal ID from server-side auth middleware. */
  principalId: string;
  /** Active tenant ID from trusted request context; absent means deny. */
  tenantId?: string;
  /** Membership must be established by the caller from trusted membership data. */
  isTenantMember: boolean;
  /** Tenant-level connector invocation grant, resolved from server-side roles. */
  canInvokeTenantConnector: boolean;
}

export interface ConnectorInstallationAccess {
  /** Tenant that owns this installation. */
  tenantId: string;
  /** Principal that created/owns a personal installation. */
  ownerId: string;
  visibility: ConnectorVisibility;
  state: ConnectorInstallationState;
  /** Explicit principal grants for personal installations. */
  grantedPrincipalIds?: readonly string[];
}

export type ConnectorAccessDeniedReason =
  | 'missing_tenant_context'
  | 'tenant_mismatch'
  | 'not_tenant_member'
  | 'connector_not_connected'
  | 'not_owner_or_granted'
  | 'permission_denied';

export type ConnectorAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: ConnectorAccessDeniedReason };

/**
 * Decide whether a trusted principal may invoke a connector installation.
 *
 * Tenant membership and connector visibility are checked independently:
 * being in a tenant does not automatically grant access to another member's
 * personal connector. Connected and degraded installations may execute tools; degraded is an operational health warning, not an authorization revocation.
 */
export function authorizeConnectorInvocation(
  context: ConnectorAccessContext,
  installation: ConnectorInstallationAccess,
): ConnectorAccessDecision {
  if (!context.tenantId) {
    return { allowed: false, reason: 'missing_tenant_context' };
  }

  if (context.tenantId !== installation.tenantId) {
    return { allowed: false, reason: 'tenant_mismatch' };
  }

  if (!context.isTenantMember) {
    return { allowed: false, reason: 'not_tenant_member' };
  }

  if (installation.state !== 'connected' && installation.state !== 'degraded') {
    return { allowed: false, reason: 'connector_not_connected' };
  }

  if (installation.visibility === 'personal') {
    const isOwner = context.principalId === installation.ownerId;
    const isGranted = installation.grantedPrincipalIds?.includes(context.principalId) ?? false;
    if (!isOwner && !isGranted) {
      return { allowed: false, reason: 'not_owner_or_granted' };
    }
    return { allowed: true };
  }

  if (!context.canInvokeTenantConnector) {
    return { allowed: false, reason: 'permission_denied' };
  }

  return { allowed: true };
}
