/** Safe lifecycle outcomes exposed to connector orchestration; never contains token values. */
export interface ConnectorOAuthTokenResult {
  expiresAt: number;
  scopes: string[];
  refreshTokenRotated: boolean;
}

export interface ConnectorOAuthAdapter {
  readonly provider: string;
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    tokenType: string;
  }>;
  refreshAccessToken(input: {
    refreshToken: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
    scopes: string[];
    tokenType: string;
  }>;
  revokeToken(input: { token: string }): Promise<void>;
}
