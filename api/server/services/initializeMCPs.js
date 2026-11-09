const mongoose = require('mongoose');
const { logger, tenantStorage } = require('@librechat/data-schemas');
const { resolveMCPAppsPolicy } = require('librechat-data-provider');
const {
  registerShutdownTask,
  setMCPToolsChangedHandler,
  getDeploymentPluginMcpServers,
  setMCPToolsChangedGenerationHandler,
  setMCPToolsChangedGenerationRenewalHandler,
  setMCPToolsChangedRevisionHandler,
  createMCPAppBindingCodec,
  createMCPPolicyResolver,
  ConnectorService,
  ConnectorCredentialVault,
  GoogleWorkspaceOAuthAdapter,
  GoogleWorkspaceOAuthFlow,
  encryptGoogleOAuthVerifier,
  decryptGoogleOAuthVerifier,
  createConnectorAuditWriter,
  createConnectorMCPAuthorizationGuard,
  createTenantConnectorPermissionResolver,
  reportStoredMCPTombstones,
} = require('@librechat/api');
const { syncStaticTools, mergeAppTools, getAppConfig, invalidateCachedTools } = require('./Config');
const { startMCPAuthorizationFenceRetryWorker } = require('./MCPAuthorizationFenceRetry');
const {
  getMCPToolsCacheGeneration,
  renewMCPToolsCacheGeneration,
  getNextAppToolsPublicationRevision,
  updateMCPServerTools,
} = require('./Config/mcp');
const { createMCPServersRegistry, createMCPManager } = require('~/config');
const db = require('~/models');

let connectorCredentialVault;
let googleWorkspaceOAuthFlow;

/**
 * Refreshes one server's tools after it reported `notifications/tools/list_changed`.
 *
 * A server that builds tools at runtime is the case this exists for: without it the tool list
 * stayed frozen at connection time and only a restart picked up the change (#7117). The list is
 * re-fetched from the live connection and written over that server's cache entry, so tools that
 * disappeared stop being advertised too.
 */
async function refreshChangedServerTools({
  serverName,
  userId,
  tools,
  serverConfig,
  publicationGeneration,
  publicationRevision,
  capabilityProfile,
}) {
  await updateMCPServerTools({
    userId,
    serverName,
    tools,
    serverConfig,
    ...(publicationGeneration && { publicationGeneration }),
    ...(publicationRevision && { publicationRevision }),
    capabilityProfile,
  });
  const toolCount = tools.length;
  logger.info(
    `[MCP][${serverName}] Tool list changed; refreshed ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}${userId ? ` for user ${userId}` : ''}`,
  );
}

/**
 * Merges Agent Plugins MCP servers under the configured servers. A plugin never
 * displaces a server the operator declared in `librechat.yaml`.
 */
function withPluginServers(configured) {
  const pluginServers = getDeploymentPluginMcpServers();
  const names = Object.keys(pluginServers);
  if (names.length === 0) {
    return configured;
  }

  const merged = { ...configured };
  for (const name of names) {
    /** Own-property check: an inherited member like `toString` is not a conflict. */
    if (Object.hasOwn(merged, name)) {
      logger.warn(
        `[MCP] Plugin server "${name}" conflicts with a configured server and was skipped.`,
      );
      continue;
    }
    /** Defined rather than assigned so a name like `__proto__` cannot reach a setter. */
    Object.defineProperty(merged, name, {
      value: pluginServers[name],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}

/**
 * Initialize MCP servers
 */
async function initializeMCPs() {
  const appConfig = await getAppConfig({ baseOnly: true });
  const mcpServers = withPluginServers(appConfig.mcpConfig);

  try {
    createMCPServersRegistry(
      mongoose,
      appConfig?.mcpSettings?.allowedDomains,
      appConfig?.mcpSettings?.allowedAddresses,
      createMCPPolicyResolver(getAppConfig),
      resolveMCPAppsPolicy(
        appConfig?.mcpSettings?.apps,
        undefined,
        appConfig?.mcpAppSandbox?.maxPersistedAppBytes,
        appConfig?.mcpAppSandbox?.maxAdmissionRequestsPerMinute,
        appConfig?.mcpAppSandbox?.url,
        appConfig?.mcpAppSandbox?.maxActiveViews,
        appConfig?.mcpAppSandbox?.maxActionPreviewChars,
        appConfig?.mcpAppSandbox?.operationLimits,
      ),
    );
  } catch (error) {
    logger.error('[MCP] Failed to initialize MCPServersRegistry:', error);
    throw error;
  }

  /** Runs alongside the connections below. It never rejects, so a failed start leaves no unhandled rejection. */
  const tombstoneReport = reportStoredMCPTombstones(
    (fieldPath) => db.listConfigTombstones(fieldPath),
    appConfig?.mcpConfig,
  );

  try {
    // Connector authorization is request-scoped: these adapters read trusted tenant/user
    // AsyncLocalStorage context inside each MCP discovery and execution request.
    const connectorService = new ConnectorService({
      installations: {
        getConnectorInstallation: (installationId) => db.getConnectorInstallation(installationId),
      },
      resolvePrincipalPermissions: createTenantConnectorPermissionResolver({
        // Both reads execute under the request's trusted tenant AsyncLocalStorage context.
        // getPartitionRole bypasses the shared role cache so permission revocation applies
        // to the next discovery/execution authorization check.
        getUserById: (principalId, fields) => db.getUserById(principalId, fields),
        getPartitionRole: (roleName) => db.getPartitionRole(roleName),
      }),
      audit: createConnectorAuditWriter((input, options) => db.recordAuditEntry(input, options)),
    });
    connectorCredentialVault = new ConnectorCredentialVault(
      {
        putConnectorCredential: (input) => db.putConnectorCredential(input),
        getConnectorCredentialCiphertext: (installationId) =>
          db.getConnectorCredentialCiphertext(installationId),
        deleteConnectorCredential: (installationId) =>
          db.deleteConnectorCredential(installationId),
      },
      connectorService,
    );

    const googleScopes = (process.env.GOOGLE_WORKSPACE_SCOPES || '')
      .split(/[ ,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
    if (
      process.env.GOOGLE_WORKSPACE_CLIENT_ID &&
      process.env.GOOGLE_WORKSPACE_CLIENT_SECRET &&
      process.env.GOOGLE_WORKSPACE_REDIRECT_URI &&
      googleScopes.length > 0 &&
      /^[a-f\d]{64}$/i.test(process.env.CONNECTOR_OAUTH_STATE_KEY || '') &&
      /^[a-f\d]{64}$/i.test(process.env.CONNECTOR_CREDENTIALS_KEY || '')
    ) {
      try {
        // These constraints are security-critical even when MONGO_AUTO_INDEX is disabled.
        await mongoose.models.GoogleOAuthState.createIndexes();
        const adapter = new GoogleWorkspaceOAuthAdapter({
          clientId: process.env.GOOGLE_WORKSPACE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_WORKSPACE_CLIENT_SECRET,
        });
        googleWorkspaceOAuthFlow = new GoogleWorkspaceOAuthFlow({
          adapter,
          vault: connectorCredentialVault,
          installations: {
            getConnectorInstallation: (installationId) =>
              db.getConnectorInstallation(installationId),
            transitionConnectorInstallation: (input) =>
              db.transitionConnectorInstallation(input),
          },
          states: {
            create: async (pending) => {
              const context = {
                stateHash: pending.stateHash,
                tenantId: pending.tenantId,
                principalId: pending.principalId,
                installationId: pending.installationId,
                redirectUri: pending.redirectUri,
                expiresAt: pending.expiresAt.getTime(),
              };
              await db.createGoogleOAuthState({
                ...pending,
                encryptedCodeVerifier: encryptGoogleOAuthVerifier(pending.codeVerifier, context),
              });
            },
            consume: async (stateHash) => {
              const pending = await db.consumeGoogleOAuthState(stateHash);
              if (!pending) return null;
              const context = {
                stateHash: pending.stateHash,
                tenantId: pending.tenantId,
                principalId: pending.principalId,
                installationId: pending.installationId,
                redirectUri: pending.redirectUri,
                expiresAt: pending.expiresAt.getTime(),
              };
              const { encryptedCodeVerifier, ...safePending } = pending;
              return {
                ...safePending,
                codeVerifier: decryptGoogleOAuthVerifier(encryptedCodeVerifier, context),
              };
            },
          },
          runWithIdentity: (identity, operation) => {
            const current = tenantStorage.getStore() || {};
            return tenantStorage.run(
              { ...current, tenantId: identity.tenantId, userId: identity.principalId },
              async () => operation(),
            );
          },
          clientId: process.env.GOOGLE_WORKSPACE_CLIENT_ID,
          redirectUri: process.env.GOOGLE_WORKSPACE_REDIRECT_URI,
          scopes: googleScopes,
        });
      } catch {
        googleWorkspaceOAuthFlow = undefined;
        logger.warn(
          '[Connectors] Google Workspace OAuth is disabled because its server configuration is invalid.',
        );
      }
    } else {
      googleWorkspaceOAuthFlow = undefined;
    }

    const connectorAuthorizationGuard = createConnectorMCPAuthorizationGuard({
      findInstallationByMCPServerId: (mcpServerId) =>
        db.getConnectorInstallationBindingByMCPServerId(mcpServerId),
      authorizeInstallation: (installationId) => connectorService.authorize(installationId),
    });

    const mcpManager = await createMCPManager(mcpServers || {}, {
      connectorAuthorizationGuard,
      catalogRecoveryMaxStateEntries: appConfig?.mcpSettings?.catalogRecovery?.maxStateEntries,
      catalogRecoveryMaxDetachedDiscoveries:
        appConfig?.mcpSettings?.catalogRecovery?.maxDetachedDiscoveries,
      appBindingCodec: createMCPAppBindingCodec(process.env.JWT_SECRET),
    });
    startMCPAuthorizationFenceRetryWorker(invalidateCachedTools, {
      intervalMs: appConfig?.mcpSettings?.catalogRecovery?.authorizationFenceRetryIntervalMs,
      batchSize: appConfig?.mcpSettings?.catalogRecovery?.authorizationFenceRetryBatchSize,
      attemptTimeoutMs: appConfig?.mcpSettings?.catalogRecovery?.authorizationFenceTimeoutMs,
    });
    setMCPToolsChangedHandler(refreshChangedServerTools);
    setMCPToolsChangedGenerationHandler(getMCPToolsCacheGeneration);
    setMCPToolsChangedGenerationRenewalHandler(renewMCPToolsCacheGeneration);
    setMCPToolsChangedRevisionHandler(({ serverName, configGeneration }) =>
      getNextAppToolsPublicationRevision(serverName, configGeneration),
    );
    registerShutdownTask('MCP app connections', () => mcpManager.disconnectAppServers());

    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const mcpTools = (await mcpManager.getAppToolFunctions()) || {};
      try {
        await mergeAppTools(mcpTools, appConfig.availableTools || {});
      } finally {
        await mcpManager.connectAppServers();
      }
      const serverCount = Object.keys(mcpServers).length;
      const toolCount = Object.keys(mcpTools).length;
      logger.info(
        `[MCP] Initialized with ${serverCount} configured ${serverCount === 1 ? 'server' : 'servers'} and ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}.`,
      );
    } else {
      await syncStaticTools(appConfig.availableTools || {});
      logger.debug('[MCP] No servers configured. MCPManager ready for UI-based servers.');
    }
  } catch (error) {
    logger.error('[MCP] Failed to initialize MCPManager:', error);
    throw error;
  }
  await tombstoneReport;
}

module.exports = initializeMCPs;
module.exports.getConnectorCredentialVault = () => connectorCredentialVault;
module.exports.getGoogleWorkspaceOAuthFlow = () => googleWorkspaceOAuthFlow;
module.exports.refreshChangedServerTools = refreshChangedServerTools;
