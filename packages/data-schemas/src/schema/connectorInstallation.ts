import { Schema } from 'mongoose';
import { CONNECTOR_INSTALLATION_STATES } from '~/types/connectorInstallation';
import type { ConnectorInstallationDocument } from '~/types/connectorInstallation';

const connectorInstallationSchema = new Schema<ConnectorInstallationDocument>(
  {
    tenantId: { type: String, index: true },
    ownerUserId: { type: String, required: true, index: true },
    provider: { type: String, required: true, trim: true, lowercase: true },
    instanceKey: { type: String, required: true },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    visibility: { type: String, enum: ['personal', 'tenant'], required: true },
    state: {
      type: String,
      enum: CONNECTOR_INSTALLATION_STATES,
      required: true,
      default: 'disconnected',
    },
    // Opaque reference only. Never put access tokens, refresh tokens, API keys,
    // OAuth codes, QR payloads, or WhatsApp session material in this document.
    credentialRef: { type: String, select: false },
    // Binds this connector to a database-backed MCP server by immutable record ID.
    mcpServerId: { type: String, match: /^[a-f\d]{24}$/i },
    grantedPrincipalIds: { type: [String], default: [] },
    lastConnectedAt: { type: Date },
    lastErrorCode: { type: String, maxlength: 80 },
    healthVersion: { type: Number, required: true, default: 0, min: 0 },
    consecutiveHealthFailures: { type: Number, required: true, default: 0, min: 0, max: 1000 },
    lastHealthCheckAt: { type: Date },
    lastSuccessfulHealthCheckAt: { type: Date },
    version: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, strict: 'throw' },
);

connectorInstallationSchema.index(
  { tenantId: 1, ownerUserId: 1, provider: 1, instanceKey: 1 },
  { unique: true, name: 'connector_installation_owner_provider_instance_tenant_unique' },
);
connectorInstallationSchema.index(
  { tenantId: 1, mcpServerId: 1 },
  {
    unique: true,
    partialFilterExpression: { mcpServerId: { $type: 'string' } },
    name: 'connector_installation_mcp_server_tenant_unique',
  },
);
connectorInstallationSchema.index(
  { tenantId: 1, state: 1, updatedAt: -1 },
  { name: 'connector_installation_tenant_state_updated' },
);

export default connectorInstallationSchema;
