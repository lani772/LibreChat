import type { Types } from 'mongoose';

export interface ConnectorCredentialDocument {
  _id: Types.ObjectId;
  tenantId: string;
  installationId: string;
  ownerUserId: string;
  provider: string;
  /** AES-256-GCM envelope; ciphertext only, never plaintext. */
  encryptedPayload: string;
  keyVersion: 'gcm1';
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorCredentialCiphertext {
  tenantId: string;
  installationId: string;
  provider: string;
  encryptedPayload: string;
  keyVersion: 'gcm1';
}

export interface ConnectorCredentialSummary {
  installationId: string;
  provider: string;
  credentialPresent: true;
  updatedAt: Date;
}
