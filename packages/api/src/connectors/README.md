# Connector service and authorization

The pure authorization policy is implemented in authorization.ts. ConnectorService is the server-side enforcement primitive for connector-backed execution.

## Trusted identity

The service reads the principal and tenant only from the existing @librechat/data-schemas AsyncLocalStorage context (getUserId() and getTenantId()). It does not accept tenant, owner, or principal IDs as method arguments. System/no-tenant contexts fail closed.

A required injected permission resolver verifies current tenant membership and the tenant-shared connector invocation permission against authoritative membership/role data. The role permission is `MCP_SERVERS.INVOKE_CONNECTORS`, distinct from general `MCP_SERVERS.USE`. Lookup failures deny access. The adapter is injected rather than guessing membership from a request body or role label. The `createConnectorAuditWriter` adapter writes to LibreChat's existing append-only, hash-chained audit log using the `mcp.tool_invoked` action and `failClosed: true`. Audit records contain only safe identifiers and outcome metadata; audit failure also fails closed.

## Invocation ordering

Use ConnectorService.execute(installationId, operation) at the provider/MCP execution boundary. It loads the installation using the tenant-scoped data method, evaluates tenant match, membership, personal owner/grants or tenant-shared permission, and connected state, then writes a redacted audit event. The callback runs only after all checks and the allow audit complete. Put credential lookup and provider dispatch inside that callback.

The service returns a generic not-found-style access error to avoid connector enumeration. Audit records contain only tenant/principal/installation identifiers, provider, outcome, and a safe reason code. They must not contain tokens, credential references, QR payloads, message bodies, or tool arguments.

## MCP runtime integration

The trusted binding guard is now injected into the existing MCPManager. It resolves connector installations only by the resolved MCP server record's dbId; model-supplied server names, tool arguments, and installation IDs are never used as binding keys. A connector-backed server is authorized before tool-catalog discovery, before connection checkout, and again immediately before every upstream tools/call (including retry paths). Lookup and authorization failures propagate or suppress discovery; they do not silently fall back to an unguarded connector call. Ordinary unbound MCP servers continue through the existing MCP path.

The production resolver verifies the principal through the tenant-isolated User model and reads the role from the active tenant partition without using the shared role cache. It checks `MCP_SERVERS.INVOKE_CONNECTORS` on every authorization attempt, so a role change takes effect on the next discovery or tool call. The permission is separate from `MCP_SERVERS.USE`: general MCP use does not implicitly authorize tenant-shared connector use. The new permission defaults to false for the USER role and true for ADMIN; custom roles must be explicitly granted it. Personal connector owners and explicitly granted principals still require tenant membership and connected state.

This guard protects MCP discovery and execution. Provider-specific OAuth handshakes, refresh-token rotation, and direct first-party provider execution adapters remain separate integration work.

## Protected credential vault

Connector credentials are stored in the separate `connectorcredentials` collection, never in the connector installation document. The persistence layer stores only an encrypted envelope and safe metadata. Ciphertext is excluded from ordinary Mongoose projections; the internal ciphertext read method is intended to be called only inside `ConnectorCredentialVault.withCredentials()` after `ConnectorService.execute()` has authorized and audited the caller.

New connector secrets use AES-256-GCM with a fresh 96-bit nonce per write. The tenant ID, installation ID, and provider are authenticated as additional data, so ciphertext cannot be transplanted between tenants, installations, or providers. Authentication-tag failure is fatal; there is no plaintext or legacy-cipher fallback. Payloads are limited to 64 KiB. The dedicated `CONNECTOR_CREDENTIALS_KEY` must be a 32-byte hexadecimal key supplied by the deployment secret manager; generate a value with `openssl rand -hex 32`. Do not commit the key or log it. Do not reuse `CREDS_KEY`.

The new credential collection is included in the tenant index migration. Installation revocation marks the installation revoked before deleting its encrypted credential row; if cleanup fails, the revoked installation remains unusable and cleanup can be retried. Owner-only writes and deletes derive the owner from trusted request context. Authorized reads are tenant-scoped and are only exposed through the vault service.

**Operational boundary:** this milestone establishes encrypted persistence and the authorized vault service. It does not yet implement a KMS/HSM-backed keyring, automated key rotation/re-encryption, provider OAuth refresh/revocation calls, or concrete Google Workspace/Chatwoot/n8n/WhatsApp adapters. Those must be completed before production provider credentials are onboarded. Never put OAuth codes, QR pairing payloads, or WhatsApp session material in connector installation records.
