import { Schema } from 'mongoose';
import type { ConnectorCredentialDocument } from '~/types/connectorCredential';

const connectorCredentialSchema = new Schema<ConnectorCredentialDocument>(
  {
    tenantId: { type: String, required: true, index: true },
    installationId: { type: String, required: true, match: /^[a-f\d]{24}$/i },
    ownerUserId: { type: String, required: true, index: true },
    provider: { type: String, required: true, trim: true, lowercase: true },
    encryptedPayload: { type: String, required: true, select: false, maxlength: 100_000 },
    keyVersion: { type: String, enum: ['gcm1'], required: true },
  },
  { timestamps: true, strict: 'throw' },
);

connectorCredentialSchema.index(
  { tenantId: 1, installationId: 1 },
  { unique: true, name: 'connector_credential_tenant_installation_unique' },
);

export default connectorCredentialSchema;
