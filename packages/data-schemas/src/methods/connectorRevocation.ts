import type { Model } from 'mongoose';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import type { ConnectorInstallationDocument } from '~/types/connectorInstallation';
import type {
  ConnectorRevocationDocument,
  ConnectorRevocationState,
} from '~/types/connectorRevocation';

export interface ConnectorRevocationRotationRecord {
  id: string;
  tenantId: string;
  installationId: string;
  provider: 'google-workspace';
  encryptedPayload: string;
  updatedAt: Date;
}

export interface ConnectorRevocationMethods {
  listConnectorRevocationsForRotation(input: { afterId?: string; limit: number }): Promise<ConnectorRevocationRotationRecord[]>;
  replaceConnectorRevocationForRotation(input: {
    id: string;
    tenantId: string;
    expectedEncryptedPayload: string;
    expectedUpdatedAt: Date;
    encryptedPayload: string;
  }): Promise<boolean>;
  enqueueGoogleWorkspaceRevocation(input: {
    installationId: string;
    encryptedPayload: string;
  }): Promise<{ id: string; state: ConnectorRevocationState }>;
  claimGoogleWorkspaceRevocation(input: {
    leaseToken: string;
    leaseUntil: Date;
  }): Promise<{
    id: string;
    tenantId: string;
    installationId: string;
    provider: 'google-workspace';
    encryptedPayload: string;
    attempts: number;
    leaseToken: string;
  } | null>;
  isConnectorInstallationRevokedForSystem(input: {
    tenantId: string;
    installationId: string;
  }): Promise<boolean>;
  completeGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
  }): Promise<boolean>;
  retryGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
    nextAttemptAt: Date;
    errorCode: string;
    maxAttempts: number;
  }): Promise<'rescheduled' | 'dead' | 'lost'>;
}

export function createConnectorRevocationMethods(
  mongoose: typeof import('mongoose'),
): ConnectorRevocationMethods {
  const Revocation = mongoose.models.ConnectorRevocation as Model<ConnectorRevocationDocument>;
  const Installation = mongoose.models.ConnectorInstallation as Model<ConnectorInstallationDocument>;

  async function listConnectorRevocationsForRotation(input: {
    afterId?: string;
    limit: number;
  }): Promise<ConnectorRevocationRotationRecord[]> {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Credential key rotation requires explicit system context');
    }
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('Credential rotation batch size must be between 1 and 100');
    }
    const filter: Record<string, unknown> = {
      state: { $ne: 'complete' },
      encryptedPayload: { $exists: true, $ne: null },
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: null },
        { leaseUntil: { $lte: new Date() } },
      ],
    };
    if (input.afterId) {
      if (!mongoose.isValidObjectId(input.afterId)) throw new Error('Invalid revocation rotation cursor');
      filter._id = { $gt: input.afterId };
    }
    const rows = await Revocation.find(filter)
      .select('+encryptedPayload tenantId installationId provider updatedAt')
      .sort({ _id: 1 })
      .limit(input.limit)
      .lean<ConnectorRevocationDocument[]>()
      .exec();
    return rows.filter((row) => typeof row.encryptedPayload === 'string').map((row) => ({
      id: row._id.toString(),
      tenantId: row.tenantId,
      installationId: row.installationId,
      provider: row.provider,
      encryptedPayload: row.encryptedPayload!,
      updatedAt: row.updatedAt,
    }));
  }

  async function replaceConnectorRevocationForRotation(input: {
    id: string;
    tenantId: string;
    expectedEncryptedPayload: string;
    expectedUpdatedAt: Date;
    encryptedPayload: string;
  }): Promise<boolean> {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Credential key rotation requires explicit system context');
    }
    if (!mongoose.isValidObjectId(input.id) || !input.tenantId ||
        !input.expectedEncryptedPayload || !input.encryptedPayload ||
        input.encryptedPayload.length > 140_000) {
      throw new Error('Invalid revocation credential rotation update');
    }
    const result = await Revocation.updateOne(
      {
        _id: input.id,
        tenantId: input.tenantId,
        state: { $ne: 'complete' },
        encryptedPayload: input.expectedEncryptedPayload,
        updatedAt: input.expectedUpdatedAt,
        $or: [
          { leaseUntil: { $exists: false } },
          { leaseUntil: null },
          { leaseUntil: { $lte: new Date() } },
        ],
      },
      { $set: { encryptedPayload: input.encryptedPayload } },
      { runValidators: true },
    ).exec();
    return result.modifiedCount === 1;
  }

  async function enqueueGoogleWorkspaceRevocation(input: {
    installationId: string;
    encryptedPayload: string;
  }): Promise<{ id: string; state: ConnectorRevocationState }> {
    const tenantId = getTenantId();
    const principalId = getUserId();
    if (!tenantId || tenantId === SYSTEM_TENANT_ID || !principalId) {
      throw new Error('Google revocation enqueue requires an authenticated tenant owner');
    }
    if (!mongoose.isValidObjectId(input.installationId) ||
        !input.encryptedPayload || input.encryptedPayload.length > 140_000) {
      throw new Error('Invalid Google revocation job');
    }
    const installation = await Installation.findOne({
      _id: input.installationId,
      ownerUserId: principalId,
      provider: 'google-workspace',
      state: { $ne: 'revoked' },
    }).select('_id').lean<{ _id: unknown }>().exec();
    if (!installation) throw new Error('Google Workspace installation is unavailable');

    const job = await Revocation.findOneAndUpdate(
      { installationId: input.installationId, tenantId },
      {
        $setOnInsert: {
          tenantId,
          installationId: input.installationId,
          provider: 'google-workspace',
          encryptedPayload: input.encryptedPayload,
          state: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).select('_id state').lean<ConnectorRevocationDocument>().exec();
    if (!job) throw new Error('Unable to persist Google revocation job');
    return { id: job._id.toString(), state: job.state };
  }

  async function claimGoogleWorkspaceRevocation(input: {
    leaseToken: string;
    leaseUntil: Date;
  }) {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Google revocation worker requires explicit system context');
    }
    if (!input.leaseToken || input.leaseToken.length > 128 ||
        !(input.leaseUntil instanceof Date) || input.leaseUntil.getTime() <= Date.now()) {
      throw new Error('Invalid Google revocation lease');
    }
    const now = new Date();
    const job = await Revocation.findOneAndUpdate(
      {
        state: { $in: ['pending', 'processing'] },
        encryptedPayload: { $exists: true, $ne: null },
        nextAttemptAt: { $lte: now },
        $or: [
          { leaseUntil: { $exists: false } },
          { leaseUntil: null },
          { leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: { state: 'processing', leaseToken: input.leaseToken, leaseUntil: input.leaseUntil },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { nextAttemptAt: 1, _id: 1 }, runValidators: true },
    )
      .select('+encryptedPayload +leaseToken tenantId installationId provider attempts')
      .lean<ConnectorRevocationDocument>()
      .exec();
    if (!job || !job.encryptedPayload) return null;
    return {
      id: job._id.toString(),
      tenantId: job.tenantId,
      installationId: job.installationId,
      provider: job.provider,
      encryptedPayload: job.encryptedPayload,
      attempts: job.attempts,
      leaseToken: input.leaseToken,
    };
  }

  async function isConnectorInstallationRevokedForSystem(input: {
    tenantId: string;
    installationId: string;
  }): Promise<boolean> {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Google revocation worker requires explicit system context');
    }
    if (!input.tenantId || !mongoose.isValidObjectId(input.installationId)) return false;
    const installation = await Installation.findOne({
      _id: input.installationId,
      tenantId: input.tenantId,
      provider: 'google-workspace',
      state: 'revoked',
    }).select('_id').lean<{ _id: unknown }>().exec();
    return Boolean(installation);
  }

  async function completeGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
  }): Promise<boolean> {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Google revocation worker requires explicit system context');
    }
    if (!mongoose.isValidObjectId(input.id) || !input.leaseToken) return false;
    const result = await Revocation.updateOne(
      { _id: input.id, state: 'processing', leaseToken: input.leaseToken },
      {
        $set: { state: 'complete', encryptedPayload: null, lastErrorCode: null },
        $unset: { leaseToken: 1, leaseUntil: 1 },
      },
    ).exec();
    return result.modifiedCount === 1;
  }

  async function retryGoogleWorkspaceRevocation(input: {
    id: string;
    leaseToken: string;
    nextAttemptAt: Date;
    errorCode: string;
    maxAttempts: number;
  }): Promise<'rescheduled' | 'dead' | 'lost'> {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Google revocation worker requires explicit system context');
    }
    if (!mongoose.isValidObjectId(input.id) || !input.leaseToken ||
        !(input.nextAttemptAt instanceof Date) ||
        !/^[a-zA-Z0-9_.-]{1,80}$/.test(input.errorCode) ||
        !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      throw new Error('Invalid Google revocation retry update');
    }
    const current = await Revocation.findOne({
      _id: input.id,
      state: 'processing',
      leaseToken: input.leaseToken,
    }).select('attempts').lean<{ attempts: number }>().exec();
    if (!current) return 'lost';
    const dead = current.attempts >= input.maxAttempts;
    const result = await Revocation.updateOne(
      { _id: input.id, state: 'processing', leaseToken: input.leaseToken },
      {
        $set: {
          state: dead ? 'dead' : 'pending',
          nextAttemptAt: input.nextAttemptAt,
          lastErrorCode: input.errorCode,
        },
        $unset: { leaseToken: 1, leaseUntil: 1 },
      },
    ).exec();
    return result.modifiedCount === 1 ? (dead ? 'dead' : 'rescheduled') : 'lost';
  }

  return {
    listConnectorRevocationsForRotation,
    replaceConnectorRevocationForRotation,
    enqueueGoogleWorkspaceRevocation,
    claimGoogleWorkspaceRevocation,
    isConnectorInstallationRevokedForSystem,
    completeGoogleWorkspaceRevocation,
    retryGoogleWorkspaceRevocation,
  };
}
