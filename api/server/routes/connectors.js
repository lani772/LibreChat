const { Router } = require('express');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const db = require('~/models');
const { requireJwtAuth, requireSameOrigin, loginLimiter } = require('~/server/middleware');
const {
  getGoogleWorkspaceOAuthFlow,
  getGoogleWorkspaceTokenLifecycle,
  getGoogleDriveReadOnlyConnector,
} = require('~/server/services/initializeMCPs');

const router = Router();

function setNoStoreHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

function clientResultUrl(result) {
  const base = process.env.DOMAIN_CLIENT || 'http://localhost:3080';
  const url = new URL('/', base);
  url.searchParams.set('googleWorkspace', result);
  return url.toString();
}

function sendDriveError(res, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
  if (status === 400) return res.status(400).json({ error: 'Invalid Google Drive request' });
  if (status === 403) return res.status(403).json({ error: 'Google Drive read permission is required' });
  if (status === 404) return res.status(404).json({ error: 'Google Drive resource is unavailable' });
  return res.status(502).json({ error: 'Google Drive is temporarily unavailable' });
}

router.get(
  '/google-workspace/:installationId/status',
  loginLimiter,
  requireJwtAuth,
  async (req, res) => {
    setNoStoreHeaders(res);
    const tenantId = getTenantId();
    const principalId = getUserId();
    const { installationId } = req.params;
    if (!tenantId || !principalId || !/^[a-f\d]{24}$/i.test(installationId)) {
      return res.status(404).json({ error: 'Connector installation is unavailable' });
    }
    try {
      const installation = await db.getConnectorInstallation(installationId);
      if (
        !installation ||
        installation.tenantId !== tenantId ||
        installation.ownerUserId !== principalId ||
        installation.provider !== 'google-workspace'
      ) {
        return res.status(404).json({ error: 'Connector installation is unavailable' });
      }
      return res.status(200).json({
        id: installation._id.toString(),
        displayName: installation.displayName,
        provider: installation.provider,
        visibility: installation.visibility,
        state: installation.state,
        lastConnectedAt: installation.lastConnectedAt || null,
        lastErrorCode: installation.lastErrorCode || null,
      });
    } catch {
      return res.status(404).json({ error: 'Connector installation is unavailable' });
    }
  },
);

/** Read-only metadata listing; the connector service performs trusted tenant/owner authorization. */
router.get(
  '/google-workspace/:installationId/drive/files',
  loginLimiter,
  requireJwtAuth,
  async (req, res) => {
    setNoStoreHeaders(res);
    const drive = getGoogleDriveReadOnlyConnector();
    if (!drive) return res.status(503).json({ error: 'Google Drive connector is not configured' });
    const pageSize = req.query.pageSize === undefined ? undefined : Number(req.query.pageSize);
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const pageToken = typeof req.query.pageToken === 'string' ? req.query.pageToken : undefined;
    const allowedOrder = ['name', 'modifiedTime', 'createdTime', 'name_natural'];
    const orderBy = typeof req.query.orderBy === 'string' && allowedOrder.includes(req.query.orderBy)
      ? req.query.orderBy : undefined;
    try {
      const result = await drive.listFiles({
        installationId: req.params.installationId,
        ...(query !== undefined ? { query } : {}),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(pageToken !== undefined ? { pageToken } : {}),
        ...(orderBy !== undefined ? { orderBy } : {}),
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendDriveError(res, error);
    }
  },
);

/** Retrieves metadata only; file content and export/download endpoints are intentionally absent. */
router.get(
  '/google-workspace/:installationId/drive/files/:fileId',
  loginLimiter,
  requireJwtAuth,
  async (req, res) => {
    setNoStoreHeaders(res);
    const drive = getGoogleDriveReadOnlyConnector();
    if (!drive) return res.status(503).json({ error: 'Google Drive connector is not configured' });
    try {
      const file = await drive.getFile({
        installationId: req.params.installationId,
        fileId: req.params.fileId,
      });
      return res.status(200).json(file);
    } catch (error) {
      return sendDriveError(res, error);
    }
  },
);

router.post(
  '/google-workspace/:installationId/authorize',
  loginLimiter,
  requireJwtAuth,
  requireSameOrigin,
  async (req, res) => {
    setNoStoreHeaders(res);
    const flow = getGoogleWorkspaceOAuthFlow();
    if (!flow) {
      return res.status(503).json({ error: 'Google Workspace authorization is not configured' });
    }
    const tenantId = getTenantId();
    const principalId = getUserId();
    const { installationId } = req.params;
    if (!tenantId || !principalId || !/^[a-f\d]{24}$/i.test(installationId)) {
      return res.status(403).json({ error: 'Connector authorization is unavailable' });
    }
    try {
      const result = await flow.begin({
        identity: { tenantId, principalId },
        installationId,
      });
      return res.status(200).json({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch {
      return res.status(404).json({ error: 'Connector authorization is unavailable' });
    }
  },
);

router.delete(
  '/google-workspace/:installationId/disconnect',
  loginLimiter,
  requireJwtAuth,
  requireSameOrigin,
  async (req, res) => {
    setNoStoreHeaders(res);
    const tenantId = getTenantId();
    const principalId = getUserId();
    const { installationId } = req.params;
    if (!tenantId || !principalId || !/^[a-f\d]{24}$/i.test(installationId)) {
      return res.status(404).json({ error: 'Connector installation is unavailable' });
    }
    try {
      const installation = await db.getConnectorInstallation(installationId);
      if (
        !installation ||
        installation.tenantId !== tenantId ||
        installation.ownerUserId !== principalId ||
        installation.provider !== 'google-workspace'
      ) {
        return res.status(404).json({ error: 'Connector installation is unavailable' });
      }
      const lifecycle = getGoogleWorkspaceTokenLifecycle();
      if (!lifecycle) {
        return res.status(503).json({ error: 'Google Workspace disconnect is not configured' });
      }
      const result = await lifecycle.disconnect(installationId);
      if (!result.disconnected) {
        return res.status(409).json({ error: 'Connector could not be disconnected; retry safely' });
      }
      return res.status(200).json({
        disconnected: true,
        remoteRevocation: result.remoteRevocation,
      });
    } catch {
      return res.status(500).json({ error: 'Unable to disconnect Google Workspace' });
    }
  },
);

/** Public callback: one-time state is the sole correlation credential. */
router.get('/google-workspace/callback', loginLimiter, async (req, res) => {
  setNoStoreHeaders(res);
  const flow = getGoogleWorkspaceOAuthFlow();
  if (!flow) return res.redirect(302, clientResultUrl('failed'));

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const providerError = typeof req.query.error === 'string' ? req.query.error : '';
  if (providerError) {
    await flow.cancel({ state }).catch(() => false);
    return res.redirect(302, clientResultUrl('failed'));
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || !code) return res.redirect(302, clientResultUrl('failed'));
  try {
    await flow.complete({ state, code });
    return res.redirect(302, clientResultUrl('connected'));
  } catch {
    return res.redirect(302, clientResultUrl('failed'));
  }
});

module.exports = router;
