import { Schema } from 'mongoose';
import type { GoogleOAuthStateDocument } from '~/types/googleOAuthState';

/** Short-lived OAuth transaction state. It is globally addressable only by a high-entropy hash. */
const googleOAuthStateSchema = new Schema<GoogleOAuthStateDocument>(
  {
    stateHash: { type: String, required: true, match: /^[A-Za-z0-9_-]{43}$/, immutable: true },
    tenantId: { type: String, required: true, immutable: true },
    principalId: { type: String, required: true, immutable: true },
    installationId: { type: String, required: true, match: /^[a-f\d]{24}$/i, immutable: true },
    redirectUri: { type: String, required: true, maxlength: 2048, immutable: true },
    encryptedCodeVerifier: { type: String, required: true, select: false, maxlength: 4096, immutable: true },
    expiresAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: true, strict: 'throw' },
);

googleOAuthStateSchema.index(
  { stateHash: 1 },
  { unique: true, name: 'google_oauth_state_hash_unique' },
);
googleOAuthStateSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: 'google_oauth_state_ttl' },
);

export default googleOAuthStateSchema;
