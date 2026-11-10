import type { Types } from 'mongoose';

export type ConnectorRevocationState = 'pending' | 'processing' | 'complete' | 'dead';

export interface ConnectorRevocationDocument {
  _id: Types.ObjectId;
  tenantId: string;
  installationId: string;
  provider: 'google-workspace';
  /** Encrypted copy of the credential envelope; never plaintext. */
  encryptedPayload?: string | null;
  state: ConnectorRevocationState;
  attempts: number;
  nextAttemptAt: Date;
  leaseToken?: string | null;
  leaseUntil?: Date | null;
  lastErrorCode?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorRevocationJob {
  id: string;
  tenantId: string;
  installationId: string;
  provider: 'google-workspace';
  encryptedPayload: string;
  attempts: number;
  leaseToken: string;
}
