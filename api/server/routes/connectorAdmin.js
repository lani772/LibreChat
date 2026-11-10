const { Router } = require('express');
const { getTenantId, getUserId } = require('@librechat/data-schemas');
const db = require('~/models');
const { requireJwtAuth, loginLimiter } = require('~/server/middleware');

const router = Router();
const OBJECT_ID_RE = /^[a-f\\d]{24}$/i;
const MAX_PAGE_SIZE = 100;

function setNoStoreHeaders(res) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
}

/**
 * This surface is tenant administration, not platform administration.
 * The tenant and principal come from the authenticated request context; the
 * role is re-read from the tenant-isolated User/Role models on every request.
 */
async function requireTenantAdmin(req, res, next) {
  const tenantId = getTenantId();
  const principalId = getUserId();
  if (!tenantId || tenantId === '__SYSTEM__' || !principalId) {
    return res.status(403).json({ error: 'Tenant administrator access is required' });
  }
  try {
    const principal = await db.getUserById(principalId, ['tenantId', 'role']);
    if (!principal || principal.tenantId !== tenantId || principal.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Tenant administrator access is required' });
    }
    return next();
  } catch {
    return res.status(503).json({ error: 'Tenant permissions are temporarily unavailable' });
  }
}

/** Safe tenant-wide inventory; credential references and all secret fields are omitted. */
router.get('/installations', loginLimiter, requireJwtAuth, requireTenantAdmin, async (req, res) => {
  setNoStoreHeaders(res);
  const tenantId = getTenantId();
  try {
    const installations = await db.listConnectorInstallations({ limit: MAX_PAGE_SIZE });
    return res.status(200).json({
      installations: installations.map((installation) => ({
        id: installation._id.toString(),
        provider: installation.provider,
        displayName: installation.displayName,
        ownerId: installation.ownerUserId,
        visibility: installation.visibility,
        state: installation.state,
        grantedPrincipalCount: (installation.grantedPrincipalIds || []).length,
        mcpServerId: installation.mcpServerId || null,
        lastConnectedAt: installation.lastConnectedAt || null,
        lastErrorCode: installation.lastErrorCode || null,
        createdAt: installation.createdAt || null,
        updatedAt: installation.updatedAt || null,
        version: installation.version,
      })),
    });
  } catch {
    return res.status(503).json({ error: 'Connector inventory is temporarily unavailable' });
  }
});

/**
 * Connector-only audit view. The storage query is pinned to the authenticated
 * tenant chain and the connector target type; the response is allowlisted so
 * arbitrary audit metadata/context cannot become an admin data-exfiltration path.
 */
router.get('/audit', loginLimiter, requireJwtAuth, requireTenantAdmin, async (req, res) => {
  setNoStoreHeaders(res);
  const tenantId = getTenantId();
  const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const rawCursor = req.query.cursor === undefined ? undefined : Number(req.query.cursor);
  if (
    !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_SIZE ||
    (rawCursor !== undefined && (!Number.isSafeInteger(rawCursor) || rawCursor < 1))
  ) {
    return res.status(400).json({ error: 'Invalid connector audit pagination' });
  }
  try {
    const page = await db.listAuditLogPage(tenantId, {
      action: ['mcp.tool_invoked'],
      targetType: 'connector',
      limit: rawLimit,
      ...(rawCursor !== undefined ? { cursor: rawCursor } : {}),
    });
    return res.status(200).json({
      entries: page.entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        outcome: entry.outcome,
        severity: entry.severity,
        actor: {
          type: entry.actor.type,
          id: entry.actor.id || null,
          name: entry.actor.name,
        },
        target: {
          type: entry.target.type,
          id: entry.target.id || null,
          name: entry.target.name || null,
        },
        timestamp: entry.timestamp,
        metadata: {
          provider: typeof entry.metadata?.provider === 'string' ? entry.metadata.provider : null,
          reason: typeof entry.metadata?.reason === 'string' ? entry.metadata.reason : null,
        },
        integrity: entry.integrity,
      })),
      total: page.total,
      nextCursor: page.nextCursor,
    });
  } catch {
    return res.status(503).json({ error: 'Connector audit history is temporarily unavailable' });
  }
});

module.exports = router;
