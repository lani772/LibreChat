import type { Model } from 'mongoose';
import { getTenantId, getUserId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import type {
  GoogleOAuthStateConsumed,
  GoogleOAuthStateDocument,
  GoogleOAuthStateInput,
} from '~/types/googleOAuthState';

export interface GoogleOAuthStateMethods {
  createGoogleOAuthState(input: GoogleOAuthStateInput): Promise<void>;
  consumeGoogleOAuthState(stateHash: string): Promise<GoogleOAuthStateConsumed | null>;
}

export function createGoogleOAuthStateMethods(
  mongoose: typeof import('mongoose'),
): GoogleOAuthStateMethods {
  const State = mongoose.models.GoogleOAuthState as Model<GoogleOAuthStateDocument>;

  async function createGoogleOAuthState(input: GoogleOAuthStateInput): Promise<void> {
    const tenantId = getTenantId();
    const principalId = getUserId();
    if (!tenantId || tenantId === SYSTEM_TENANT_ID || !principalId) {
      throw new Error('Google OAuth state creation requires an authenticated tenant context');
    }
    if (input.tenantId !== tenantId || input.principalId !== principalId) {
      throw new Error('Google OAuth state identity does not match the trusted request context');
    }
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.stateHash) ||
      !mongoose.isValidObjectId(input.installationId) ||
      !input.encryptedCodeVerifier ||
      input.encryptedCodeVerifier.length > 4096 ||
      !(input.expiresAt instanceof Date) ||
      input.expiresAt.getTime() <= Date.now() ||
      input.expiresAt.getTime() > Date.now() + 11 * 60 * 1000
    ) {
      throw new Error('Invalid Google OAuth state record');
    }
    const redirect = new URL(input.redirectUri);
    if (redirect.protocol !== 'https:' && redirect.hostname !== 'localhost') {
      throw new Error('Google OAuth redirect URI must use HTTPS');
    }
    await State.create({
      stateHash: input.stateHash,
      tenantId,
      principalId,
      installationId: input.installationId,
      // Preserve the exact configured URI: Google requires it to match at token exchange.
      redirectUri: input.redirectUri,
      encryptedCodeVerifier: input.encryptedCodeVerifier,
      expiresAt: input.expiresAt,
    });
  }

  async function consumeGoogleOAuthState(
    stateHash: string,
  ): Promise<GoogleOAuthStateConsumed | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(stateHash)) return null;
    // Atomic delete: exactly one concurrent callback can obtain this transaction.
    const row = await State.findOneAndDelete({
      stateHash,
      expiresAt: { $gt: new Date() },
    })
      .select(
        '+encryptedCodeVerifier stateHash tenantId principalId installationId redirectUri expiresAt',
      )
      .lean<GoogleOAuthStateDocument>()
      .exec();
    if (!row) return null;
    return {
      stateHash: row.stateHash,
      tenantId: row.tenantId,
      principalId: row.principalId,
      installationId: row.installationId,
      redirectUri: row.redirectUri,
      encryptedCodeVerifier: row.encryptedCodeVerifier,
      expiresAt: row.expiresAt,
    };
  }

  return { createGoogleOAuthState, consumeGoogleOAuthState };
}
