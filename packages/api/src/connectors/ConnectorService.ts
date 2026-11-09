import { getTenantId, getUserId } from '@librechat/data-schemas';
import type {
  ConnectorInstallationDocument,
  RecordAuditEntryInput,
  RecordAuditEntryOptions,
} from '@librechat/data-schemas';
import {
  authorizeConnectorInvocation,
  type ConnectorAccessDeniedReason,
  type ConnectorInstallationAccess,
} from './authorization';

export interface ConnectorPrincipalPermissions {
  isTenantMember: boolean;
  canInvokeTenantConnector: boolean;
}
export interface ConnectorInstallationRepository {
  getConnectorInstallation(installationId: string): Promise<ConnectorInstallationDocument | null>;
}
export interface ConnectorServiceDependencies {
  installations: ConnectorInstallationRepository;
  resolvePrincipalPermissions: (input: {
    tenantId: string;
    principalId: string;
  }) => Promise<ConnectorPrincipalPermissions>;
  /** Receives identifiers and outcome only; never credentials or message content. */
  audit: (event: {
    action: 'connector.invoke';
    tenantId: string;
    principalId: string;
    installationId: string;
    provider: string;
    outcome: 'allowed' | 'denied';
    reason?: ConnectorAccessDeniedReason | 'not_found' | 'permission_lookup_failed';
  }) => Promise<void>;
}
export class ConnectorAccessError extends Error {
  readonly code = 'CONNECTOR_ACCESS_DENIED';
  readonly statusCode = 404;
  constructor() {
    super('Connector installation is unavailable');
  }
}
export interface AuthorizedConnector {
  installation: Omit<ConnectorInstallationDocument, 'credentialRef'>;
  tenantId: string;
  principalId: string;
}

/**
 * Server-side enforcement primitive. Identity is read only from trusted
 * AsyncLocalStorage context; caller/model-supplied identity is never accepted.
 * Invoke execute() before credential lookup, discovery, or provider dispatch.
 */
export class ConnectorService {
  constructor(private readonly deps: ConnectorServiceDependencies) {}

  private getTrustedIdentity(): { tenantId: string; principalId: string } {
    const tenantId = getTenantId();
    const principalId = getUserId();
    if (!tenantId || tenantId === '__SYSTEM__' || !principalId) {
      throw new ConnectorAccessError();
    }
    return { tenantId, principalId };
  }

  public async authorize(installationId: string): Promise<AuthorizedConnector> {
    const { tenantId, principalId } = this.getTrustedIdentity();
    let installation: ConnectorInstallationDocument | null;
    try {
      installation = await this.deps.installations.getConnectorInstallation(installationId);
    } catch {
      throw new ConnectorAccessError();
    }
    if (!installation || !installation.tenantId) {
      await this.writeAudit({
        action: 'connector.invoke', tenantId, principalId, installationId,
        provider: installation?.provider ?? 'unknown', outcome: 'denied', reason: 'not_found',
      });
      throw new ConnectorAccessError();
    }

    let permissions: ConnectorPrincipalPermissions;
    try {
      permissions = await this.deps.resolvePrincipalPermissions({ tenantId, principalId });
      if (
        typeof permissions?.isTenantMember !== 'boolean' ||
        typeof permissions?.canInvokeTenantConnector !== 'boolean'
      ) {
        throw new Error('Incomplete connector permission result');
      }
    } catch {
      await this.writeAudit({
        action: 'connector.invoke', tenantId, principalId, installationId,
        provider: installation.provider, outcome: 'denied', reason: 'permission_lookup_failed',
      });
      throw new ConnectorAccessError();
    }

    const access: ConnectorInstallationAccess = {
      tenantId: installation.tenantId,
      ownerId: installation.ownerUserId,
      visibility: installation.visibility,
      state: installation.state,
      grantedPrincipalIds: installation.grantedPrincipalIds,
    };
    const decision = authorizeConnectorInvocation(
      { tenantId, principalId, ...permissions },
      access,
    );
    if (!decision.allowed) {
      await this.writeAudit({
        action: 'connector.invoke', tenantId, principalId, installationId,
        provider: installation.provider, outcome: 'denied', reason: decision.reason,
      });
      throw new ConnectorAccessError();
    }

    await this.writeAudit({
      action: 'connector.invoke', tenantId, principalId, installationId,
      provider: installation.provider, outcome: 'allowed',
    });
    const safeInstallation = { ...installation };
    delete safeInstallation.credentialRef;
    return { installation: safeInstallation, tenantId, principalId };
  }

  /** Callback (including credential lookup) is reached only after authorization and audit. */
  public async execute<TResult>(
    installationId: string,
    operation: (connector: AuthorizedConnector) => Promise<TResult>,
  ): Promise<TResult> {
    const authorized = await this.authorize(installationId);
    return operation(authorized);
  }

  private async writeAudit(event: {
    action: 'connector.invoke';
    tenantId: string;
    principalId: string;
    installationId: string;
    provider: string;
    outcome: 'allowed' | 'denied';
    reason?: ConnectorAccessDeniedReason | 'not_found' | 'permission_lookup_failed';
  }): Promise<void> {
    try {
      await this.deps.audit(event);
    } catch {
      // Fail closed: never run a provider operation without its required audit record.
      throw new ConnectorAccessError();
    }
  }
}


/**
 * Adapts LibreChat's append-only, hash-chained audit writer to connector events.
 * failClosed is mandatory: connector operations never proceed without a durable
 * allow record, and denied attempts are also persisted where possible.
 */
export function createConnectorAuditWriter(
  recordAuditEntry: (
    input: RecordAuditEntryInput,
    options?: RecordAuditEntryOptions,
  ) => Promise<unknown>,
): NonNullable<ConnectorServiceDependencies['audit']> {
  return async (event) => {
    await recordAuditEntry(
      {
        action: 'mcp.tool_invoked',
        outcome: event.outcome === 'allowed' ? 'success' : 'denied',
        severity: event.outcome === 'allowed' ? 'info' : 'warning',
        actor: { type: 'user', id: event.principalId, name: event.principalId },
        target: {
          type: 'connector',
          id: event.installationId,
          name: event.provider,
        },
        tenantId: event.tenantId,
        metadata: {
          provider: event.provider,
          ...(event.reason ? { reason: event.reason } : {}),
        },
      },
      { failClosed: true },
    );
  };
}
