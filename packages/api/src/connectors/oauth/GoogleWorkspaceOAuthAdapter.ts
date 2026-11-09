import type { ConnectorOAuthAdapter } from './types';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOCATION_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const REQUEST_TIMEOUT_MS = 10_000;

export interface GoogleWorkspaceOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export type OAuthFetch = typeof fetch;

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Google OAuth response is missing ${field}`);
  }
  return value;
}

function parseTokenResponse(body: GoogleTokenResponse, requireRefreshToken: boolean) {
  const accessToken = requiredString(body.access_token, 'access_token');
  const refreshToken =
    typeof body.refresh_token === 'string' && body.refresh_token.length > 0
      ? body.refresh_token
      : undefined;
  if (requireRefreshToken && !refreshToken) {
    throw new Error('Google did not issue a refresh token; reconnect with offline access and consent');
  }
  if (typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new Error('Google OAuth response contains an invalid expires_in value');
  }
  const scopes =
    typeof body.scope === 'string'
      ? body.scope.split(/\s+/).filter(Boolean)
      : [];
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
    scopes,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
  };
}

/**
 * Google Workspace OAuth token endpoint adapter.
 *
 * This class performs only fixed-endpoint token exchange, refresh, and revocation.
 * Authorization URL construction, state/PKCE storage, tenant authorization, and
 * encrypted persistence remain responsibilities of the connector orchestration layer.
 */
export class GoogleWorkspaceOAuthAdapter implements ConnectorOAuthAdapter {
  readonly provider = 'google-workspace';

  constructor(
    private readonly config: GoogleWorkspaceOAuthConfig,
    private readonly fetcher: OAuthFetch = fetch,
  ) {
    if (!config.clientId?.trim() || !config.clientSecret?.trim()) {
      throw new Error('Google Workspace OAuth client configuration is required');
    }
  }

  private async postForm(endpoint: string, values: Record<string, string>): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Google OAuth endpoint is temporarily unavailable');
    }
    if (!response.ok) {
      // Do not propagate provider response bodies: they can contain sensitive request details.
      throw new Error(`Google OAuth request failed (HTTP ${response.status})`);
    }
    return response;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }) {
    if (!input.code?.trim() || !input.redirectUri?.trim()) {
      throw new Error('Authorization code and redirect URI are required');
    }
    const form: Record<string, string> = {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
    };
    if (input.codeVerifier) {
      form.code_verifier = input.codeVerifier;
    }
    const response = await this.postForm(TOKEN_ENDPOINT, form);
    const body = (await response.json()) as GoogleTokenResponse;
    const parsed = parseTokenResponse(body, true);
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken!,
      expiresAt: parsed.expiresAt,
      scopes: parsed.scopes,
      tokenType: parsed.tokenType,
    };
  }

  async refreshAccessToken(input: { refreshToken: string }) {
    if (!input.refreshToken?.trim()) {
      throw new Error('A refresh token is required');
    }
    const response = await this.postForm(TOKEN_ENDPOINT, {
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    });
    const parsed = parseTokenResponse((await response.json()) as GoogleTokenResponse, false);
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      scopes: parsed.scopes,
      tokenType: parsed.tokenType,
    };
  }

  async revokeToken(input: { token: string }): Promise<void> {
    if (!input.token?.trim()) {
      throw new Error('A token is required for revocation');
    }
    const response = await this.fetcher(REVOCATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: input.token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => {
      throw new Error('Google token revocation endpoint is temporarily unavailable');
    });
    // Google documents HTTP 200 for success. Treat 400 as already-invalid/revoked only
    // when the provider has rejected the token; other errors remain retryable failures.
    if (!response.ok && response.status !== 400) {
      throw new Error(`Google token revocation failed (HTTP ${response.status})`);
    }
  }
}
