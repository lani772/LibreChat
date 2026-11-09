# Connector service and authorization

The pure authorization policy is implemented in authorization.ts. ConnectorService is the server-side enforcement primitive for connector-backed execution.

## Trusted identity

The service reads the principal and tenant only from the existing @librechat/data-schemas AsyncLocalStorage context (getUserId() and getTenantId()). It does not accept tenant, owner, or principal IDs as method arguments. System/no-tenant contexts fail closed.

A required injected permission resolver must verify current tenant membership and the tenant-shared connector invocation permission against authoritative membership/role data. Lookup failures deny access. The adapter is injected rather than guessing membership from a request body or role label. The `createConnectorAuditWriter` adapter writes to LibreChat's existing append-only, hash-chained audit log using the `mcp.tool_invoked` action and `failClosed: true`. Audit records contain only safe identifiers and outcome metadata; audit failure also fails closed.

## Invocation ordering

Use ConnectorService.execute(installationId, operation) at the provider/MCP execution boundary. It loads the installation using the tenant-scoped data method, evaluates tenant match, membership, personal owner/grants or tenant-shared permission, and connected state, then writes a redacted audit event. The callback runs only after all checks and the allow audit complete. Put credential lookup and provider dispatch inside that callback.

The service returns a generic not-found-style access error to avoid connector enumeration. Audit records contain only tenant/principal/installation identifiers, provider, outcome, and a safe reason code. They must not contain tokens, credential references, QR payloads, message bodies, or tool arguments.

## MCP runtime integration

The trusted binding guard is now injected into the existing MCPManager. It resolves connector installations only by the resolved MCP server record's dbId; model-supplied server names, tool arguments, and installation IDs are never used as binding keys. A connector-backed server is authorized before tool-catalog discovery, before connection checkout, and again immediately before every upstream tools/call (including retry paths). Lookup and authorization failures propagate or suppress discovery; they do not silently fall back to an unguarded connector call. Ordinary unbound MCP servers continue through the existing MCP path.

The production membership adapter verifies the principal by reading the tenant-isolated User model under the active tenant context. Tenant-shared invocation is intentionally denied for now (canInvokeTenantConnector: false) because the current role schema does not yet define a dedicated connector-invocation permission. Personal connector owners and explicitly granted principals can proceed when tenant membership and connected state are verified. Do not change the shared-connector default to allow until a real role/permission is introduced and tested.

This guard protects MCP discovery and execution. It does not yet provide the credential vault, provider-specific credential retrieval/revocation, or direct first-party provider execution adapters. Those remain separate implementation milestones.

## Credential handling

credentialRef remains an opaque pointer only. No vault adapter is implemented in this milestone. Never store credentials, OAuth codes, QR payloads, WhatsApp sessions, or other secret material in the installation record.
