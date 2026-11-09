import {
  authorizeConnectorInvocation,
  type ConnectorAccessContext,
  type ConnectorInstallationAccess,
} from './authorization';

const context = (overrides: Partial<ConnectorAccessContext> = {}): ConnectorAccessContext => ({
  principalId: 'user-a',
  tenantId: 'tenant-a',
  isTenantMember: true,
  canInvokeTenantConnector: true,
  ...overrides,
});

const installation = (
  overrides: Partial<ConnectorInstallationAccess> = {},
): ConnectorInstallationAccess => ({
  tenantId: 'tenant-a',
  ownerId: 'user-a',
  visibility: 'personal',
  state: 'connected',
  ...overrides,
});

describe('authorizeConnectorInvocation', () => {
  it('allows the owner of a connected personal connector', () => {
    expect(authorizeConnectorInvocation(context(), installation())).toEqual({ allowed: true });
  });

  it('denies when trusted tenant context is missing', () => {
    expect(
      authorizeConnectorInvocation(context({ tenantId: undefined }), installation()),
    ).toEqual({ allowed: false, reason: 'missing_tenant_context' });
  });

  it('denies cross-tenant access before checking ownership or grants', () => {
    expect(
      authorizeConnectorInvocation(
        context({ tenantId: 'tenant-b', principalId: 'user-b' }),
        installation({ grantedPrincipalIds: ['user-b'] }),
      ),
    ).toEqual({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('denies a principal who is no longer a tenant member', () => {
    expect(
      authorizeConnectorInvocation(context({ isTenantMember: false }), installation()),
    ).toEqual({ allowed: false, reason: 'not_tenant_member' });
  });

  it('denies a tenant member from using another member personal connector without a grant', () => {
    expect(
      authorizeConnectorInvocation(
        context({ principalId: 'user-b' }),
        installation({ ownerId: 'user-a' }),
      ),
    ).toEqual({ allowed: false, reason: 'not_owner_or_granted' });
  });

  it('allows an explicitly granted principal to use a personal connector', () => {
    expect(
      authorizeConnectorInvocation(
        context({ principalId: 'user-b' }),
        installation({ grantedPrincipalIds: ['user-b'] }),
      ),
    ).toEqual({ allowed: true });
  });

  it('requires the tenant connector invocation permission for shared connectors', () => {
    expect(
      authorizeConnectorInvocation(
        context({ canInvokeTenantConnector: false }),
        installation({ visibility: 'tenant' }),
      ),
    ).toEqual({ allowed: false, reason: 'permission_denied' });
  });

  it('denies disconnected, authorizing, degraded, revoked, and errored installations', () => {
    for (const state of ['disconnected', 'authorizing', 'degraded', 'revoked', 'error'] as const) {
      expect(authorizeConnectorInvocation(context(), installation({ state }))).toEqual({
        allowed: false,
        reason: 'connector_not_connected',
      });
    }
  });
});
