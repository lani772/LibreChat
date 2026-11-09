const { Router } = require('express');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const { requireJwtAuth, requireSameOrigin, loginLimiter } = require('~/server/middleware');
const { getGoogleWorkspaceOAuthFlow } = require('~/server/services/initializeMCPs');

const router = Router();

function setNoStoreHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

function clientResultUrl(result) {
  const base = process.env.DOMAIN_CLIENT || 'http://localhost:3080';
  const url = new URL('/connectors', base);
  url.searchParams.set('googleWorkspace', result);
  return url.toString();
}

/**
 * Start connector authorization only from an authenticated, same-origin browser request.
 * The installation owner and tenant are read from trusted AsyncLocalStorage context.
 */
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
      // Do not expose installation existence, ownership, state, or provider details.
      return res.status(404).json({ error: 'Connector authorization is unavailable' });
    }
  },
);

/**
 * Public OAuth callback. State is the sole correlation credential; tenant and principal
 * are recovered from the atomically consumed server-side state record.
 */
router.get('/google-workspace/callback', loginLimiter, async (req, res) => {
  setNoStoreHeaders(res);
  const flow = getGoogleWorkspaceOAuthFlow();
  if (!flow) {
    return res.redirect(302, clientResultUrl('failed'));
  }

  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const providerError = typeof req.query.error === 'string' ? req.query.error : '';
  if (providerError) {
    await flow.cancel({ state }).catch(() => false);
    return res.redirect(302, clientResultUrl('failed'));
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!state || !code) {
    return res.redirect(302, clientResultUrl('failed'));
  }

  try {
    await flow.complete({ state, code });
    return res.redirect(302, clientResultUrl('connected'));
  } catch {
    // OAuth codes, state values, tokens, and provider response bodies are never logged.
    return res.redirect(302, clientResultUrl('failed'));
  }
});

module.exports = router;
