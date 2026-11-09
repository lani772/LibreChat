const express = require('express');
const request = require('supertest');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const db = require('~/models');
const { getGoogleWorkspaceOAuthFlow } = require('~/server/services/initializeMCPs');

jest.mock('@librechat/data-schemas', () => ({
  getTenantId: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('~/models', () => ({
  getConnectorInstallation: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => next(),
  requireSameOrigin: (_req, _res, next) => next(),
  loginLimiter: (_req, _res, next) => next(),
}));

jest.mock('~/server/services/initializeMCPs', () => ({
  getGoogleWorkspaceOAuthFlow: jest.fn(),
}));

describe('Google Workspace connector routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'user-a' };
      next();
    });
    app.use('/api/connectors', require('../connectors'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getTenantId.mockReturnValue('tenant-a');
    getUserId.mockReturnValue('user-a');
  });

  it('starts authorization using trusted tenant and principal context', async () => {
    const flow = {
      begin: jest.fn().mockResolvedValue({
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
        expiresAt: new Date('2026-11-09T20:30:00.000Z'),
      }),
    };
    getGoogleWorkspaceOAuthFlow.mockReturnValue(flow);

    const response = await request(app)
      .post('/api/connectors/google-workspace/507f1f77bcf86cd799439011/authorize')
      .send({ tenantId: 'attacker-tenant', principalId: 'attacker-user' });

    expect(response.status).toBe(200);
    expect(flow.begin).toHaveBeenCalledWith({
      identity: { tenantId: 'tenant-a', principalId: 'user-a' },
      installationId: '507f1f77bcf86cd799439011',
    });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.authorizationUrl).toContain('accounts.google.com');
  });

  it('returns only safe status fields to the installation owner', async () => {
    db.getConnectorInstallation.mockResolvedValue({
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      provider: 'google-workspace',
      displayName: 'Workspace',
      visibility: 'personal',
      state: 'connected',
      lastConnectedAt: new Date('2026-11-09T20:00:00.000Z'),
      lastErrorCode: null,
      credentialRef: 'secret-reference',
    });

    const response = await request(app)
      .get('/api/connectors/google-workspace/507f1f77bcf86cd799439011/status');

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('connected');
    expect(response.body).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(response.body)).not.toContain('secret-reference');
  });

  it('hides status when the tenant or owner does not match', async () => {
    db.getConnectorInstallation.mockResolvedValue({
      tenantId: 'tenant-b',
      ownerUserId: 'user-b',
      provider: 'google-workspace',
      state: 'connected',
    });

    const response = await request(app)
      .get('/api/connectors/google-workspace/507f1f77bcf86cd799439011/status');

    expect(response.status).toBe(404);
    expect(response.body).not.toHaveProperty('state');
  });

  it('completes the public callback and redirects to a fixed client URL', async () => {
    const flow = {
      complete: jest.fn().mockResolvedValue({ installationId: '507f1f77bcf86cd799439011' }),
    };
    getGoogleWorkspaceOAuthFlow.mockReturnValue(flow);

    const response = await request(app)
      .get('/api/connectors/google-workspace/callback')
      .query({ state: 'opaque-state', code: 'authorization-code' });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('googleWorkspace=connected');
    expect(flow.complete).toHaveBeenCalledWith({ state: 'opaque-state', code: 'authorization-code' });
  });

  it('consumes provider cancellation without reflecting provider error details', async () => {
    const flow = { cancel: jest.fn().mockResolvedValue(true) };
    getGoogleWorkspaceOAuthFlow.mockReturnValue(flow);

    const response = await request(app)
      .get('/api/connectors/google-workspace/callback')
      .query({
        state: 'opaque-state',
        error: 'access_denied',
        error_description: 'sensitive provider detail',
      });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('googleWorkspace=failed');
    expect(response.headers.location).not.toContain('sensitive');
    expect(flow.cancel).toHaveBeenCalledWith({ state: 'opaque-state' });
  });
});
