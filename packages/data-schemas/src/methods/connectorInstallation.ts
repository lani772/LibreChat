import { nanoid } from 'nanoid';
import type { Model } from 'mongoose';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import type {
  ConnectorInstallationDocument,
  ConnectorInstallationState,
  CreateConnectorInstallationInput,
} from '~/types/connectorInstallation';

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

  return {
    createConnectorInstallation,
    getConnectorInstallation,
    listConnectorInstallations,
    transitionConnectorInstallation,
    revokeConnectorInstallation,
  };
}
