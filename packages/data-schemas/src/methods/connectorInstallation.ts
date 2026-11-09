import { nanoid } from 'nanoid';
import type { Model } from 'mongoose';
import { getTenantId, getUserId, runAsSystem, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import type {
  ConnectorInstallationDocument,
  ConnectorInstallationState,
  CreateConnectorInstallationInput,
} from '~/types/connectorInstallation';
import type { MCPServerDocument } from '~/types/mcp';

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const ERROR_CODE_PATTERN = /^[a-zA-Z0-9_.-]{1,80}$/;

/** Connector installations are tenant-owned; never create or query them unscoped. */
function requireConnectorTenant(operation: string): void {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    throw new Error(`Connector installation ${operation} requires an active tenant context`);
  }
}

export interface ConnectorInstallationMethods {
  createConnectorInstallation(
    input: CreateConnectorInstallationInput,
  ): Promise<ConnectorInstallationDocument>;
  getConnectorInstallation(
    installationId: string,
  ): Promise<ConnectorInstallationDocument | null>;
  getConnectorInstallationByMCPServerId(
    mcpServerId: string,
  ): Promise<ConnectorInstallationDocument | null>;
  /** Internal existence lookup across tenant partitions; returns only the opaque installation ID. */
  getConnectorInstallationBindingByMCPServerId(
    mcpServerId: string,
  ): Promise<Pick<ConnectorInstallationDocument, '_id'> | null>;
  bindConnectorInstallationToMCPServer(params: {
    installationId: string;
    mcpServerId: string;
    expectedVersion: number;
  }): Promise<ConnectorInstallationDocument | null>;
  listConnectorInstallations(options?: {
    ownerUserId?: string;
    provider?: string;
    state?: ConnectorInstallationState;
    limit?: number;
  }): Promise<ConnectorInstallationDocument[]>;
  transitionConnectorInstallation(params: {
    installationId: string;
    expectedVersion: number;
    state: ConnectorInstallationState;
    lastErrorCode?: string;
  }): Promise<ConnectorInstallationDocument | null>;
  revokeConnectorInstallation(installationId: string): Promise<boolean>;
  updateConnectorInstallationGrants(params: {
    installationId: string;
    expectedVersion: number;
    principalIds: string[];
  }): Promise<ConnectorInstallationDocument | null>;
}

const ALLOWED_TRANSITIONS: Record<ConnectorInstallationState, readonly ConnectorInstallationState[]> = {
  disconnected: ['authorizing', 'revoked'],
  authorizing: ['connected', 'disconnected', 'error', 'revoked'],
  connected: ['degraded', 'disconnected', 'revoked', 'error'],
  degraded: ['connected', 'disconnected', 'revoked', 'error'],
  revoked: [],
  error: ['authorizing', 'disconnected', 'revoked'],
};

export function createConnectorInstallationMethods(
  mongoose: typeof import('mongoose'),
): ConnectorInstallationMethods {
  const Model = mongoose.models.ConnectorInstallation as Model<ConnectorInstallationDocument>;
  const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;

  async function createConnectorInstallation(
    input: CreateConnectorInstallationInput,
  ): Promise<ConnectorInstallationDocument> {
    requireConnectorTenant('create');
    const ownerUserId = getUserId();
    if (!ownerUserId) {
      throw new Error('Connector creation requires an authenticated user context');
    }
    const provider = input.provider.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (!PROVIDER_PATTERN.test(provider)) {
      throw new Error('Invalid connector provider identifier');
    }
    if (!displayName || displayName.length > 120) {
      throw new Error('Connector display name must contain 1–120 characters');
    }
    if (input.credentialRef != null && !input.credentialRef.trim()) {
      throw new Error('Credential reference cannot be empty');
    }

    const created = await Model.create({
      ownerUserId,
      provider,
      instanceKey: nanoid(24),
      displayName,
      visibility: input.visibility,
      state: 'disconnected',
      ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
      grantedPrincipalIds: [],
      version: 0,
    });
    const record = created.toObject();
    delete record.credentialRef;
    return record as ConnectorInstallationDocument;
  }

  async function getConnectorInstallation(
    installationId: string,
  ): Promise<ConnectorInstallationDocument | null> {
    requireConnectorTenant('read');
    if (!mongoose.isValidObjectId(installationId)) return null;
    return Model.findById(installationId)
      .lean<ConnectorInstallationDocument>()
      .exec();
  }

  async function getConnectorInstallationByMCPServerId(
    mcpServerId: string,
  ): Promise<ConnectorInstallationDocument | null> {
    requireConnectorTenant('MCP server binding lookup');
    if (!mongoose.isValidObjectId(mcpServerId)) return null;
    return Model.findOne({ mcpServerId })
      .select('-credentialRef')
      .lean<ConnectorInstallationDocument>()
      .exec();
  }

  /**
   * Internal binding-existence lookup used by the MCP guard. It deliberately runs in the
   * explicit system context so an installation bound in another tenant is still recognized
   * and denied by ConnectorService, rather than mistaken for an ordinary unbound MCP server.
   * Only the installation ID is returned; no tenant metadata or credential pointer escapes.
   */
  async function getConnectorInstallationBindingByMCPServerId(
    mcpServerId: string,
  ): Promise<Pick<ConnectorInstallationDocument, '_id'> | null> {
    if (!mongoose.isValidObjectId(mcpServerId)) return null;
    return runAsSystem(async () =>
      Model.findOne({ mcpServerId })
        .select('_id')
        .lean<Pick<ConnectorInstallationDocument, '_id'>>()
        .exec(),
    );
  }

  /** Bind only an MCP server record authored by the authenticated connector owner. */
  async function bindConnectorInstallationToMCPServer(params: {
    installationId: string;
    mcpServerId: string;
    expectedVersion: number;
  }): Promise<ConnectorInstallationDocument | null> {
    requireConnectorTenant('MCP server binding');
    const principalId = getUserId();
    if (
      !principalId ||
      !mongoose.isValidObjectId(params.installationId) ||
      !mongoose.isValidObjectId(params.mcpServerId)
    ) {
      return null;
    }
    if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 0) {
      throw new Error('Invalid connector installation version');
    }
    const server = await MCPServer.findById(params.mcpServerId)
      .select('author')
      .lean<{ author: { toString(): string } }>()
      .exec();
    if (!server || server.author?.toString() !== principalId) return null;

    return Model.findOneAndUpdate(
      {
        _id: params.installationId,
        ownerUserId: principalId,
        state: { $ne: 'revoked' },
        version: params.expectedVersion,
      },
      { $set: { mcpServerId: params.mcpServerId }, $inc: { version: 1 } },
      { new: true, runValidators: true },
    )
      .select('-credentialRef')
      .lean<ConnectorInstallationDocument>()
      .exec();
  }

  async function listConnectorInstallations(options: {
    ownerUserId?: string;
    provider?: string;
    state?: ConnectorInstallationState;
    limit?: number;
  } = {}): Promise<ConnectorInstallationDocument[]> {
    requireConnectorTenant('list');
    const filter: Record<string, unknown> = {};
    if (options.ownerUserId) filter.ownerUserId = options.ownerUserId;
    if (options.provider) filter.provider = options.provider.toLowerCase();
    if (options.state) filter.state = options.state;
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    return Model.find(filter)
      .select('-credentialRef')
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean<ConnectorInstallationDocument[]>()
      .exec();
  }

  async function transitionConnectorInstallation(params: {
    installationId: string;
    expectedVersion: number;
    state: ConnectorInstallationState;
    lastErrorCode?: string;
  }): Promise<ConnectorInstallationDocument | null> {
    requireConnectorTenant('state transition');
    if (!mongoose.isValidObjectId(params.installationId)) return null;
    if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 0) {
      throw new Error('Invalid connector installation version');
    }
    if (params.lastErrorCode != null && !ERROR_CODE_PATTERN.test(params.lastErrorCode)) {
      throw new Error('Invalid connector error code');
    }

    const current = await Model.findById(params.installationId)
      .select('state version')
      .lean<{ state: ConnectorInstallationState; version: number }>()
      .exec();
    if (!current || current.version !== params.expectedVersion) return null;
    if (!ALLOWED_TRANSITIONS[current.state].includes(params.state)) {
      throw new Error(`Invalid connector state transition: ${current.state} -> ${params.state}`);
    }

    const update: Record<string, unknown> = {
      $set: {
        state: params.state,
        ...(params.state === 'connected' ? { lastConnectedAt: new Date() } : {}),
        ...(params.lastErrorCode ? { lastErrorCode: params.lastErrorCode } : { lastErrorCode: null }),
      },
      $inc: { version: 1 },
    };
    return Model.findOneAndUpdate(
      { _id: params.installationId, version: params.expectedVersion, state: current.state },
      update,
      { new: true, runValidators: true },
    )
      .select('-credentialRef')
      .lean<ConnectorInstallationDocument>()
      .exec();
  }

  async function revokeConnectorInstallation(installationId: string): Promise<boolean> {
    requireConnectorTenant('revoke');
    if (!mongoose.isValidObjectId(installationId)) return false;
    const result = await Model.updateOne(
      { _id: installationId, state: { $ne: 'revoked' } },
      { $set: { state: 'revoked', credentialRef: null }, $inc: { version: 1 } },
    ).exec();
    return result.modifiedCount === 1;
  }


  async function updateConnectorInstallationGrants(params: {
    installationId: string;
    expectedVersion: number;
    principalIds: string[];
  }): Promise<ConnectorInstallationDocument | null> {
    requireConnectorTenant('grant update');
    if (!mongoose.isValidObjectId(params.installationId)) return null;
    if (!Number.isInteger(params.expectedVersion) || params.expectedVersion < 0) {
      throw new Error('Invalid connector installation version');
    }
    if (!Array.isArray(params.principalIds) || params.principalIds.length > 100) {
      throw new Error('Connector grants must contain no more than 100 principals');
    }
    const principalIds = [...new Set(params.principalIds.map((id) => id.trim()))];
    if (principalIds.some((id) => !id || id.length > 128)) {
      throw new Error('Invalid connector grant principal identifier');
    }

    return Model.findOneAndUpdate(
      {
        _id: params.installationId,
        visibility: 'personal',
        version: params.expectedVersion,
      },
      { $set: { grantedPrincipalIds: principalIds }, $inc: { version: 1 } },
      { new: true, runValidators: true },
    )
      .select('-credentialRef')
      .lean<ConnectorInstallationDocument>()
      .exec();
  }

  return {
    createConnectorInstallation,
    getConnectorInstallation,
    getConnectorInstallationByMCPServerId,
    getConnectorInstallationBindingByMCPServerId,
    bindConnectorInstallationToMCPServer,
    listConnectorInstallations,
    transitionConnectorInstallation,
    revokeConnectorInstallation,
    updateConnectorInstallationGrants,
  };
}
