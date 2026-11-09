# Connector installation persistence

The connector installation record stores tenant-scoped ownership and lifecycle metadata in MongoDB. It is deliberately separate from provider credentials and live MCP connections.

## Stored data

- Tenant ID, stamped by LibreChat's existing tenant-isolation plugin.
- Owner user ID, derived from the authenticated tenantStorage context (not accepted as caller input).
- Provider identifier, display name, personal/tenant visibility, and internal opaque instance key.
- Lifecycle state, optimistic version, timestamps, and a bounded error code.
- An optional opaque credential reference. This is not a token or secret; a dedicated protected credential adapter is still required before provider authentication is enabled.

The credential reference is excluded from ordinary reads and list results. The create result strips it as well. No OAuth token, API key, QR payload, WhatsApp session, or provider credential may be stored in this collection.

## Persistence behavior

- All operations require an active non-system tenant context.
- The existing Mongoose tenant-isolation plugin scopes reads and writes.
- The installation schema is registered in createModels and the data methods are exposed through createMethods.
- Tenant index migration includes the new collection.
- State transitions use an expected version and compare-and-set update to reject stale concurrent writes.
- Revocation changes state to revoked, clears the credential pointer, and increments the version.

## Security boundary still to implement

This is the persistence layer, not a complete connector service. API/service entry points must still:
1. Resolve tenant and principal from trusted authentication middleware.
2. Apply authorizeConnectorInvocation and owner/visibility policy before reads, updates, credential resolution, or execution.
3. Implement a protected credential adapter and provider-specific revoke/rotation behavior.
4. Invalidate MCP connection and tool caches on disconnect, revoke, or permission changes.
5. Add redacted audit events.

Do not expose raw data methods directly as public HTTP endpoints or model-callable tools.
