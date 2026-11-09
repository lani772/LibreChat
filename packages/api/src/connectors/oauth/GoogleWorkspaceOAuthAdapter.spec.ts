import { GoogleWorkspaceOAuthAdapter } from './GoogleWorkspaceOAuthAdapter';

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const config = { clientId: 'client-id', clientSecret: 'client-secret' };

describe('GoogleWorkspaceOAuthAdapter', () => {
  it('exchanges an authorization code and requires offline refresh credentials', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      expires_in: 3600,
      scope: 'scope.one scope.two',
      token_type: 'Bearer',
    }));
    const adapter = new GoogleWorkspaceOAuthAdapter(config, fetcher as unknown as typeof fetch);
    const result = await adapter.exchangeAuthorizationCode({
      code: 'authorization-code',
      redirectUri: 'https://app.example.test/oauth/google-workspace/callback',
      codeVerifier: 'pkce-verifier',
    });
    expect(result).toMatchObject({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      scopes: ['scope.one', 'scope.two'],
      tokenType: 'Bearer',
    });
    const body = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('client_secret')).toBe('client-secret');
  });

  it('rejects an initial authorization without a refresh token', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({
      access_token: 'access-secret',
      expires_in: 3600,
    }));
    const adapter = new GoogleWorkspaceOAuthAdapter(config, fetcher as unknown as typeof fetch);
    await expect(adapter.exchangeAuthorizationCode({
      code: 'code',
      redirectUri: 'https://app.example.test/callback',
    })).rejects.toThrow('did not issue a refresh token');
  });

  it('refreshes access tokens and allows providers that do not rotate refresh tokens', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({
      access_token: 'new-access',
      expires_in: 1800,
      scope: 'scope.one',
    }));
    const adapter = new GoogleWorkspaceOAuthAdapter(config, fetcher as unknown as typeof fetch);
    const result = await adapter.refreshAccessToken({ refreshToken: 'existing-refresh' });
    expect(result).toMatchObject({
      accessToken: 'new-access',
      refreshToken: undefined,
      scopes: ['scope.one'],
    });
    const body = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('refresh_token')).toBe('existing-refresh');
  });

  it('does not expose provider response bodies in errors', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error_description: 'sensitive provider detail' }),
    });
    const adapter = new GoogleWorkspaceOAuthAdapter(config, fetcher as unknown as typeof fetch);
    await expect(adapter.refreshAccessToken({ refreshToken: 'refresh' }))
      .rejects.toThrow('HTTP 400');
  });

  it('treats an already-invalid token as idempotently revoked', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({}, 400));
    const adapter = new GoogleWorkspaceOAuthAdapter(config, fetcher as unknown as typeof fetch);
    await expect(adapter.revokeToken({ token: 'old-token' })).resolves.toBeUndefined();
  });

  it('rejects missing OAuth client configuration', () => {
    expect(() => new GoogleWorkspaceOAuthAdapter({ clientId: '', clientSecret: '' }))
      .toThrow('configuration is required');
  });
});
