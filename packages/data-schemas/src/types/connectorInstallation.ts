import type { Types } from 'mongoose';

export const CONNECTOR_INSTALLATION_STATES = [
  'disconnected',
  'authorizing',
  'connected',
  'degraded',
  'revoked',
  'error',
] as const;

export type ConnectorInstallationState = (typeof CONNECTOR_INSTALLATION_STATES)[number];
export type ConnectorInstallationVisibility = 'personal' | 'tenant';

/**
 * Persistence record for an installed connector. Provider credentials are stored
 * separately in ConnectorCredential and are never stored here. credentialRef is
 * a legacy opaque pointer retained for compatibility; it must never contain
 * secret material. instanceKey is an internal opaque identifier, not an account
 * name, email address, phone number, or provider-issued secret.
 */
export interface ConnectorInstallationDocument {
  _id: Types.ObjectId;
  tenantId?: string;
  ownerUserId: string;
  provider: string;
  instanceKey: string;
  displayName: string;
  visibility: ConnectorInstallationVisibility;
  state: ConnectorInstallationState;
  credentialRef?: string;
  /** Stable MongoDB MCPServer record ID; never a display name. */
  mcpServerId?: string;
  grantedPrincipalIds: string[];
  lastConnectedAt?: Date;
  lastErrorCode?: string;
  healthVersion?: number;
  consecutiveHealthFailures: number;
  lastHealthCheckAt?: Date;
  lastSuccessfulHealthCheckAt?: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectorInstallationInput {
  provider: string;
  displayName: string;
  visibility: ConnectorInstallationVisibility;
  credentialRef?: string;
}

export interface ConnectorInstallationStateChange {
  installationId: string;
  expectedVersion: number;
  state: ConnectorInstallationState;
  lastErrorCode?: string;
}
