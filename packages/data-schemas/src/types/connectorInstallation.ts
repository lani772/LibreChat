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
 * Persistence record for an installed connector. Provider credentials are never
 * stored here: credentialRef is an opaque reference into the existing protected
 * credential store. instanceKey is an internal opaque identifier, not an account
 * name, email address, phone number, or provider-issued secret.
 */
import type { Types } from 'mongoose';

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
  grantedPrincipalIds: string[];
  lastConnectedAt?: Date;
  lastErrorCode?: string;
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
