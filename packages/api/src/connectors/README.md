# Connector service and authorization

The pure authorization policy is implemented in authorization.ts. ConnectorService is the server-side enforcement primitive for connector-backed execution.

## Trusted identity

The service reads the principal and tenant only from the existing @librechat/data-schemas AsyncLocalStorage context (getUserId() and getTenantId()). It does not accept tenant, owner, or principal IDs as method arguments. System/no-tenant contexts fail closed.

A required injected permission resolver must verify current tenant membership and the tenant-shared connector invocation permission against authoritative membership/role data. Lookup failures deny access. The adapter is injected rather than guessing membership from a request body or role label. A required audit writer records only safe identifiers and outcome metadata; audit failure also fails closed.

## Invocation ordering

Use ConnectorService.execute(installationId, operation) at the provider/MCP execution boundary. It loads the installation using the tenant-scoped data method, evaluates tenant match, membership, personal owner/grants or tenant-shared permission, and connected state, then writes a redacted audit event. The callback runs only after all checks and the allow audit complete. Put credential lookup and provider dispatch inside that callback.

The service returns a generic not-found-style access error to avoid connector enumeration. Audit records contain only tenant/principal/installation identifiers, provider, outcome, and a safe reason code. They must not contain tokens, credential references, QR payloads, message bodies, or tool arguments.

## Explicit integration boundary

This service is implemented and tested as an injectable enforcement boundary, but it is NOT YET wired into LibreChat's global MCPManager, Agent tool registry, or provider-specific MCP execution paths. Those paths support arbitrary MCP servers and use existing per-user OAuth/config resolution; applying this installation gate to every MCP server would incorrectly block non-connector MCP servers. The next integration step must classify connector-backed server targets and invoke this service only for those targets before discovery/execution, with provider-specific credential resolution still pending.

## Credential handling

credentialRef remains an opaque pointer only. No vault adapter is implemented in this milestone. Never store credentials, OAuth codes, QR payloads, WhatsApp sessions, or other secret material in the installation record.
