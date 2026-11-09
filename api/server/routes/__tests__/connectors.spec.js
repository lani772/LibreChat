const express = require('express');
const request = require('supertest');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const db = require('~/models');
const {
  getGoogleWorkspaceOAuthFlow,
  getGoogleWorkspaceTokenLifecycle,
  getGoogleDriveReadOnlyConnector,
} = require('~/server/services/initializeMCPs');

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
  getGoogleWorkspaceTokenLifecycle: jest.fn(),
  getGoogleDriveReadOnlyConnector: jest.fn(),
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

  it('disconnects an owned installation and reports remote revocation status', async () => {
    db.getConnectorInstallation.mockResolvedValue({
      tenantId: 'tenant-a',
      ownerUserId: 'user-a',
      provider: 'google-workspace',
      state: 'connected',
    });
    const lifecycle = {
      disconnect: jest.fn().mockResolvedValue({
        disconnected: true,
        remoteRevocation: 'pending',
      }),
    };
    getGoogleWorkspaceTokenLifecycle.mockReturnValue(lifecycle);

    const response = await request(app)
      .delete('/api/connectors/google-workspace/507f1f77bcf86cd799439011/disconnect');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      disconnected: true,
      remoteRevocation: 'pending',
    });
    expect(lifecycle.disconnect).toHaveBeenCalledWith('507f1f77bcf86cd799439011');
  });

  it('does not disconnect an installation owned by another user', async () => {
    db.getConnectorInstallation.mockResolvedValue({
      tenantId: 'tenant-a',
      ownerUserId: 'user-b',
      provider: 'google-workspace',
      state: 'connected',
    });
    const lifecycle = { disconnect: jest.fn() };
    getGoogleWorkspaceTokenLifecycle.mockReturnValue(lifecycle);

    const response = await request(app)
      .delete('/api/connectors/google-workspace/507f1f77bcf86cd799439011/disconnect');

    expect(response.status).toBe(404);
    expect(lifecycle.disconnect).not.toHaveBeenCalled();
  });


  it('lists Drive file metadata through the authorized read-only connector', async () => {
    const drive = {
      listFiles: jest.fn().mockResolvedValue({
        files: [{ id: 'file-1', name: 'Quarterly report', mimeType: 'application/pdf' }],
        nextPageToken: 'page-2',
        incompleteSearch: false,
      }),
    };
    getGoogleDriveReadOnlyConnector.mockReturnValue(drive);

    const response = await request(app)
      .get('/api/connectors/google-workspace/507f1f77bcf86cd799439011/drive/files')
      .query({ q: "name contains 'Quarterly'", pageSize: '15', pageToken: 'page-1' });

    expect(response.status).toBe(200);
    expect(response.body.files[0].name).toBe('Quarterly report');
    expect(drive.listFiles).toHaveBeenCalledWith({
      installationId: '507f1f77bcf86cd799439011',
      query: "name contains 'Quarterly'",
      pageSize: 15,
      pageToken: 'page-1',
    });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('retrieves only file metadata', async () => {
    const drive = {
      getFile: jest.fn().mockResolvedValue({ id: 'file-1', name: 'Report', mimeType: 'application/pdf' }),
    };
    getGoogleDriveReadOnlyConnector.mockReturnValue(drive);

    const response = await request(app)
      .get('/api/connectors/google-workspace/507f1f77bcf86cd799439011/drive/files/file-1');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'file-1', name: 'Report', mimeType: 'application/pdf' });
    expect(drive.getFile).toHaveBeenCalledWith({
      installationId: '507f1f77bcf86cd799439011',
      fileId: 'file-1',
    });
  });

  it('maps Drive permission failures to a safe response', async () => {
    getGoogleDriveReadOnlyConnector.mockReturnValue({
      listFiles: jest.fn().mockRejectedValue(Object.assign(new Error('provider detail'), {
        statusCode: 403,
      })),
    });
    const response = await request(app)
      .get('/api/connectors/google-workspace/507f1f77bcf86cd799439011/drive/files');
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Google Drive read permission is required');
    expect(JSON.stringify(response.body)).not.toContain('provider detail');
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
