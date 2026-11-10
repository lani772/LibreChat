import type { Model } from 'mongoose';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import type {
  ConnectorCredentialCiphertext,
  ConnectorCredentialDocument,
  ConnectorCredentialSummary,
} from '~/types/connectorCredential';
import type { ConnectorInstallationDocument } from '~/types/connectorInstallation';

function requireTenant(): string {
  const tenantId = getTenantId();
  if (!tenantId || tenantId === SYSTEM_TENANT_ID) {
    throw new Error('Connector credential operation requires an active tenant context');
  }
  return tenantId;
}

export interface ConnectorCredentialRotationRecord {
  id: string;
  tenantId: string;
  installationId: string;
  provider: string;
  encryptedPayload: string;
  updatedAt: Date;
}

export interface ConnectorCredentialMethods {
  /** System-only bounded scan used by the credential key-rotation maintenance job. */
  listConnectorCredentialsForRotation(input: {
    afterId?: string;
    limit: number;
  }): Promise<ConnectorCredentialRotationRecord[]>;
  /** Compare-and-set replacement; never overwrites a concurrent refresh or credential update. */
  replaceConnectorCredentialForRotation(input: {
    id: string;
    tenantId: string;
    expectedEncryptedPayload: string;
    expectedUpdatedAt: Date;
    encryptedPayload: string;
  }): Promise<boolean>;
  putConnectorCredential(input: {
    installationId: string;
    provider: string;
    encryptedPayload: string;
    keyVersion: 'gcm1';
    refreshLeaseToken?: string;
  }): Promise<ConnectorCredentialSummary>;
  getConnectorCredentialCiphertext(
    installationId: string,
  ): Promise<ConnectorCredentialCiphertext | null>;
  deleteConnectorCredential(installationId: string): Promise<{ deleted: boolean }>;
  claimConnectorCredentialRefresh(input: { installationId: string; leaseToken: string; leaseUntil: Date }): Promise<boolean>;
  releaseConnectorCredentialRefresh(input: { installationId: string; leaseToken: string }): Promise<boolean>;
}

export function createConnectorCredentialMethods(
  mongoose: typeof import('mongoose'),
): ConnectorCredentialMethods {
  const Credential = mongoose.models.ConnectorCredential as Model<ConnectorCredentialDocument>;
  const Installation = mongoose.models.ConnectorInstallation as Model<ConnectorInstallationDocument>;

  function requireSystemRotationContext(): void {
    if (getTenantId() !== SYSTEM_TENANT_ID) {
      throw new Error('Credential key rotation requires explicit system context');
    }
  }

  async function listConnectorCredentialsForRotation(input: {
    afterId?: string;
    limit: number;
  }): Promise<ConnectorCredentialRotationRecord[]> {
    requireSystemRotationContext();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('Credential rotation batch size must be between 1 and 100');
    }
    const filter: Record<string, unknown> = {
      $or: [
        { refreshLeaseUntil: { $exists: false } },
        { refreshLeaseUntil: null },
        { refreshLeaseUntil: { $lte: new Date() } },
      ],
    };
    if (input.afterId) {
      if (!mongoose.isValidObjectId(input.afterId)) throw new Error('Invalid credential rotation cursor');
      filter._id = { $gt: input.afterId };
    }
    const rows = await Credential.find(filter)
      .select('+encryptedPayload tenantId installationId provider updatedAt')
      .sort({ _id: 1 })
      .limit(input.limit)
      .lean<Array<ConnectorCredentialDocument & { updatedAt: Date }>>()
      .exec();
    return rows.map((row) => ({
      id: row._id.toString(),
      tenantId: row.tenantId,
      installationId: row.installationId,
      provider: row.provider,
      encryptedPayload: row.encryptedPayload,
      updatedAt: row.updatedAt,
    }));
  }

  async function replaceConnectorCredentialForRotation(input: {
    id: string;
    tenantId: string;
    expectedEncryptedPayload: string;
    expectedUpdatedAt: Date;
    encryptedPayload: string;
  }): Promise<boolean> {
    requireSystemRotationContext();
    if (!mongoose.isValidObjectId(input.id) || !input.tenantId ||
        !input.expectedEncryptedPayload || !input.encryptedPayload ||
        input.encryptedPayload.length > 140_000) {
      throw new Error('Invalid credential rotation update');
    }
    const result = await Credential.updateOne(
      {
        _id: input.id,
        tenantId: input.tenantId,
        encryptedPayload: input.expectedEncryptedPayload,
        updatedAt: input.expectedUpdatedAt,
        $or: [
          { refreshLeaseUntil: { $exists: false } },
          { refreshLeaseUntil: null },
          { refreshLeaseUntil: { $lte: new Date() } },
        ],
      },
      { $set: { encryptedPayload: input.encryptedPayload, keyVersion: 'gcm1' } },
      { runValidators: true },
    ).exec();
    return result.modifiedCount === 1;
  }

  async function putConnectorCredential(input: {
    installationId: string;
    provider: string;
    encryptedPayload: string;
    keyVersion: 'gcm1';
    refreshLeaseToken?: string;
  }): Promise<ConnectorCredentialSummary> {
    const tenantId = requireTenant();
    const ownerUserId = getUserId();
    const provider = input.provider.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(provider)) {
      throw new Error('Invalid connector credential provider');
    }
    if (!ownerUserId && !input.refreshLeaseToken) throw new Error('Credential write requires an authenticated owner');
    if (!mongoose.isValidObjectId(input.installationId)) throw new Error('Invalid installation ID');
    if (!input.encryptedPayload || input.encryptedPayload.length > 140_000) {
      throw new Error('Invalid encrypted connector credential payload');
    }
    const installation = await Installation.findOne({
      _id: input.installationId,
      ...(input.refreshLeaseToken ? {} : { ownerUserId }),
      provider,
      state: { $ne: 'revoked' },
    }).select('_id provider').lean<{ _id: unknown; provider: string }>().exec();
    if (!installation) throw new Error('Connector installation is unavailable');

    const filter: Record<string, unknown> = input.refreshLeaseToken
      ? { installationId: input.installationId, tenantId, refreshLeaseToken: input.refreshLeaseToken }
      : { installationId: input.installationId };
    const update: Record<string, unknown> = {
      $set: {
        tenantId,
        installationId: input.installationId,
        ...(input.refreshLeaseToken ? {} : { ownerUserId }),
        provider,
        encryptedPayload: input.encryptedPayload,
        keyVersion: input.keyVersion,
        ...(input.refreshLeaseToken ? { refreshLeaseToken: null, refreshLeaseUntil: null } : {}),
      },
    };
    const row = await Credential.findOneAndUpdate(
      filter,
      update,
      { upsert: !input.refreshLeaseToken, new: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .select('installationId provider updatedAt')
      .lean<ConnectorCredentialDocument>()
      .exec();
    if (!row) throw new Error(input.refreshLeaseToken ? 'Credential refresh lease was lost' : 'Unable to persist connector credential metadata');
    return {
      installationId: row.installationId,
      provider: row.provider,
      credentialPresent: true,
      updatedAt: row.updatedAt,
    };
  }

  async function getConnectorCredentialCiphertext(
    installationId: string,
  ): Promise<ConnectorCredentialCiphertext | null> {
    const tenantId = requireTenant();
    if (!mongoose.isValidObjectId(installationId)) return null;
    const row = await Credential.findOne({ installationId })
      .select('+encryptedPayload tenantId installationId provider keyVersion')
      .lean<ConnectorCredentialDocument>()
      .exec();
    if (!row || row.tenantId !== tenantId) return null;
    return {
      tenantId,
      installationId: row.installationId,
      provider: row.provider,
      encryptedPayload: row.encryptedPayload,
      keyVersion: row.keyVersion,
    };
  }

  async function deleteConnectorCredential(installationId: string): Promise<{ deleted: boolean }> {
    requireTenant();
    const ownerUserId = getUserId();
    if (!ownerUserId || !mongoose.isValidObjectId(installationId)) return { deleted: false };
    const result = await Credential.deleteOne({ installationId, ownerUserId }).exec();
    return { deleted: result.deletedCount === 1 };
  }

  async function claimConnectorCredentialRefresh(input: {
    installationId: string;
    leaseToken: string;
    leaseUntil: Date;
  }): Promise<boolean> {
    const tenantId = requireTenant();
    if (!mongoose.isValidObjectId(input.installationId) || !input.leaseToken) return false;
    const now = new Date();
    const result = await Credential.updateOne(
      {
        installationId: input.installationId,
        tenantId,
        $or: [
          { refreshLeaseUntil: { $exists: false } },
          { refreshLeaseUntil: null },
          { refreshLeaseUntil: { $lte: now } },
        ],
      },
      { $set: { refreshLeaseToken: input.leaseToken, refreshLeaseUntil: input.leaseUntil } },
    ).exec();
    return result.modifiedCount === 1;
  }

  async function releaseConnectorCredentialRefresh(input: {
    installationId: string;
    leaseToken: string;
  }): Promise<boolean> {
    const tenantId = requireTenant();
    if (!mongoose.isValidObjectId(input.installationId)) return false;
    const result = await Credential.updateOne(
      { installationId: input.installationId, tenantId, refreshLeaseToken: input.leaseToken },
      { $unset: { refreshLeaseToken: 1, refreshLeaseUntil: 1 } },
    ).exec();
    return result.modifiedCount === 1;
  }

  return { listConnectorCredentialsForRotation, replaceConnectorCredentialForRotation, putConnectorCredential, getConnectorCredentialCiphertext, deleteConnectorCredential, claimConnectorCredentialRefresh, releaseConnectorCredentialRefresh };
}
