import type { Types } from 'mongoose';

export interface GoogleOAuthStateDocument {
  _id: Types.ObjectId;
  stateHash: string;
  tenantId: string;
  principalId: string;
  installationId: string;
  redirectUri: string;
  encryptedCodeVerifier: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoogleOAuthStateInput {
  stateHash: string;
  tenantId: string;
  principalId: string;
  installationId: string;
  redirectUri: string;
  encryptedCodeVerifier: string;
  expiresAt: Date;
}

export type GoogleOAuthStateConsumed = Omit<GoogleOAuthStateDocument, '_id' | 'createdAt' | 'updatedAt'>;
