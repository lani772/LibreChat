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

export interface ConnectorCredentialMethods {
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
        ...(ownerUserId ? { ownerUserId } : {}),
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

  return { putConnectorCredential, getConnectorCredentialCiphertext, deleteConnectorCredential, claimConnectorCredentialRefresh, releaseConnectorCredentialRefresh };
}
