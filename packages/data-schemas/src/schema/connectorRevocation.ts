import { Schema } from 'mongoose';
import type { ConnectorRevocationDocument } from '~/types/connectorRevocation';

const connectorRevocationSchema: Schema<ConnectorRevocationDocument> = new Schema<ConnectorRevocationDocument>(
  {
    tenantId: { type: String, required: true, index: true, immutable: true },
    installationId: { type: String, required: true, match: /^[a-f\d]{24}$/i, immutable: true },
    provider: { type: String, enum: ['google-workspace'], required: true, immutable: true },
    encryptedPayload: { type: String, select: false, maxlength: 140_000 },
    state: { type: String, enum: ['pending', 'processing', 'complete', 'dead'], required: true, default: 'pending' },
    attempts: { type: Number, required: true, default: 0, min: 0, max: 1000 },
    nextAttemptAt: { type: Date, required: true, default: Date.now },
    leaseToken: { type: String, select: false, maxlength: 128 },
    leaseUntil: { type: Date, select: false },
    lastErrorCode: { type: String, maxlength: 80, default: null },
  },
  { timestamps: true, strict: 'throw' },
);

connectorRevocationSchema.index(
  { tenantId: 1, installationId: 1 },
  { unique: true, name: 'connector_revocation_tenant_installation_unique' },
);
connectorRevocationSchema.index(
  { state: 1, nextAttemptAt: 1, leaseUntil: 1, _id: 1 },
  { name: 'connector_revocation_due_lease' },
);

export default connectorRevocationSchema;
