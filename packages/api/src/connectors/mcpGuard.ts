import type { ConnectorInstallationDocument } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '../mcp/types';

export type ConnectorMCPAuthorizationGuard = (serverConfig: ParsedServerConfig) => Promise<void>;

export interface ConnectorMCPAuthorizationGuardDependencies {
  /** Tenant-scoped lookup keyed only by the trusted MCPServer database ID. */
  findInstallationByMCPServerId: (
    mcpServerId: string,
  ) => Promise<Pick<ConnectorInstallationDocument, '_id'> | null>;
  /** Performs the full trusted-identity, membership, visibility, state, and audit checks. */
  authorizeInstallation: (installationId: string) => Promise<unknown>;
}

/**
 * Binds connector enforcement to the resolved MCPServer record, never to a model-provided
 * server name, tool argument, or caller-supplied installation ID.
 *
 * No mapping means this is an ordinary MCP server. Lookup failures intentionally propagate:
 * a database outage must not silently turn a connector lookup into an unguarded MCP call.
 */
export function createConnectorMCPAuthorizationGuard(
  deps: ConnectorMCPAuthorizationGuardDependencies,
): ConnectorMCPAuthorizationGuard {
  return async (serverConfig) => {
    const mcpServerId = serverConfig.dbId;
    if (!mcpServerId) return;

    const installation = await deps.findInstallationByMCPServerId(mcpServerId);
    if (!installation) return;

    await deps.authorizeInstallation(installation._id.toString());
  };
}
