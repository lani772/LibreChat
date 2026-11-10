const express = require('express');
const request = require('supertest');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const db = require('~/models');

jest.mock('@librechat/data-schemas', () => ({
  getTenantId: jest.fn(),
  getUserId: jest.fn(),
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  listConnectorInstallations: jest.fn(),
  listAuditLogPage: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
  loginLimiter: (_req, _res, next) => next(),
}));

describe('tenant connector administration routes', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use('/api/admin/connectors', require('../connectorAdmin'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    getTenantId.mockReturnValue('tenant-a');
    getUserId.mockReturnValue('admin-a');
    db.getUserById.mockResolvedValue({ tenantId: 'tenant-a', role: 'ADMIN' });
  });

  it('denies non-admin tenant members before reading connector inventory', async () => {
    db.getUserById.mockResolvedValue({ tenantId: 'tenant-a', role: 'USER' });
    const response = await request(app).get('/api/admin/connectors/installations');
    expect(response.status).toBe(403);
    expect(db.listConnectorInstallations).not.toHaveBeenCalled();
  });

  it('denies a principal whose stored tenant differs from trusted request tenant', async () => {
    db.getUserById.mockResolvedValue({ tenantId: 'tenant-b', role: 'ADMIN' });
    const response = await request(app).get('/api/admin/connectors/installations');
    expect(response.status).toBe(403);
    expect(db.listConnectorInstallations).not.toHaveBeenCalled();
  });

  it('returns tenant connector inventory without credential pointers or grant identities', async () => {
    db.listConnectorInstallations.mockResolvedValue([{
      _id: { toString: () => '507f1f77bcf86cd799439011' },
      provider: 'google-workspace',
      displayName: 'Finance Drive',
      ownerUserId: 'owner-a',
      visibility: 'personal',
      state: 'connected',
      grantedPrincipalIds: ['member-a', 'member-b'],
      mcpServerId: '507f1f77bcf86cd799439012',
      credentialRef: 'secret-pointer',
      version: 4,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    }]);

    const response = await request(app).get('/api/admin/connectors/installations');
    expect(response.status).toBe(200);
    expect(db.listConnectorInstallations).toHaveBeenCalledWith({ limit: 100 });
    expect(response.body.installations[0]).toMatchObject({
      id: '507f1f77bcf86cd799439011',
      provider: 'google-workspace',
      ownerId: 'owner-a',
      grantedPrincipalCount: 2,
      mcpServerId: '507f1f77bcf86cd799439012',
    });
    expect(response.body.installations[0]).not.toHaveProperty('credentialRef');
    expect(response.body.installations[0]).not.toHaveProperty('grantedPrincipalIds');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('queries only connector invocation events in the trusted tenant audit chain', async () => {
    db.listAuditLogPage.mockResolvedValue({
      entries: [{
        id: 'audit-1',
        action: 'mcp.tool_invoked',
        outcome: 'denied',
        severity: 'warning',
        actor: { type: 'user', id: 'member-a', name: 'Member A' },
        target: { type: 'connector', id: 'connector-a', name: 'google-workspace' },
        timestamp: '2026-11-10T00:00:00.000Z',
        metadata: { provider: 'google-workspace', reason: 'not_owner', secret: 'must-not-leak' },
        context: { ip: '192.0.2.1', userAgent: 'private' },
        integrity: { seq: 9, hash: 'hash', prevHash: 'prev' },
      }],
      total: 1,
      nextCursor: null,
    });

    const response = await request(app).get('/api/admin/connectors/audit?limit=20&cursor=10');
    expect(response.status).toBe(200);
    expect(db.listAuditLogPage).toHaveBeenCalledWith('tenant-a', {
      action: ['mcp.tool_invoked'],
      targetType: 'connector',
      limit: 20,
      cursor: 10,
    });
    expect(response.body.entries[0].metadata).toEqual({
      provider: 'google-workspace',
      reason: 'not_owner',
    });
    expect(response.body.entries[0]).not.toHaveProperty('context');
    expect(response.body.entries[0].metadata).not.toHaveProperty('secret');
  });

  it('rejects unbounded or malformed audit pagination', async () => {
    const response = await request(app).get('/api/admin/connectors/audit?limit=1000');
    expect(response.status).toBe(400);
    expect(db.listAuditLogPage).not.toHaveBeenCalled();
  });

  it('fails closed when the tenant membership lookup fails', async () => {
    db.getUserById.mockRejectedValue(new Error('database unavailable'));
    const response = await request(app).get('/api/admin/connectors/installations');
    expect(response.status).toBe(503);
    expect(db.listConnectorInstallations).not.toHaveBeenCalled();
  });
});
