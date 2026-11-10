# Connector installation and credential persistence

Connector installation metadata and provider credentials are stored separately. Installation documents contain tenant ownership, visibility, lifecycle, MCP binding, and version metadata. They must never contain provider secrets.

## Installation records

- Tenant ID is stamped and enforced by LibreChat's tenant-isolation plugin.
- Owner ID is derived from trusted tenant request context.
- Provider, display name, visibility, opaque instance key, state, and optimistic version are stored.
- Ordinary reads and list results do not expose the legacy `credentialRef` field.
- The new credential vault does not store plaintext or ciphertext in installation documents.
- Revocation changes installation state first, clears the legacy pointer, increments the version, and deletes the separate encrypted credential record.

## Credential vault

The `connectorcredentials` collection stores only an AES-256-GCM envelope, tenant ID, installation ID, provider, owner ID, and encryption-envelope format metadata. The encrypted payload is excluded from normal Mongoose projections. Its unique index is tenant + installation scoped, and the collection participates in the tenant index migration.

Owner-only writes and deletes derive the principal from trusted request context and verify that the connector installation belongs to that owner and tenant. Credential reads are tenant-scoped. Application code should obtain plaintext only through `ConnectorCredentialVault.withCredentials()`, which invokes `ConnectorService.execute()` first so authorization and durable audit complete before ciphertext lookup/decryption.

New credentials require the dedicated `CONNECTOR_CREDENTIALS_KEY` environment variable: exactly 32 bytes encoded as 64 hexadecimal characters. Use a deployment secret manager; generate a key with `openssl rand -hex 32`. Never commit or log it, and do not reuse `CREDS_KEY`. AES-GCM authenticates the tenant ID, installation ID, and provider as additional authenticated data. Tampering or moving a ciphertext between contexts fails decryption. There is no plaintext or legacy-cipher fallback. Payloads are limited to 64 KiB.

## MCP authorization integration

Connector installations bind to database-backed MCP servers through the immutable MongoDB `MCPServer` record ID. The existing MCPManager guard resolves this binding from trusted `ParsedServerConfig.dbId`, authorizes before discovery and execution, and rechecks immediately before upstream tool dispatch. Ordinary unbound MCP servers retain their existing behavior.

Tenant-shared connector invocation requires the dedicated `MCP_SERVERS.INVOKE_CONNECTORS` role permission. It is separate from general MCP use. Permission is resolved from the current tenant role on every authorization attempt. Personal connector access still requires tenant membership and owner or explicit grant.

## Security boundaries and remaining work

- Never expose raw data methods as public HTTP endpoints or model-callable tools.
- Provider adapters must call `withCredentials()` for every provider request and must never return credential values in tool results, model context, or logs.
- Provider-specific OAuth handshakes, refresh-token rotation, remote provider revocation, and concrete Google Workspace/Chatwoot/n8n/WhatsApp adapters are not yet implemented.
- KMS/HSM-backed key management and automated key rotation/re-encryption are not yet implemented. Plan a coordinated re-encryption migration before rotating the active key.
- Installation revocation disables authorization before ciphertext deletion. If deletion fails, the installation remains unusable; retry cleanup through the owner-scoped delete operation.
- Tests have been authored for encryption integrity, context binding, tenant isolation, owner checks, authorization-before-decryption, and revocation cleanup. They still need to be executed in a configured checkout.


## Remote revocation outbox

Google Workspace remote revocation jobs live in the tenant-isolated `connectorrevocations` collection. The record stores only an encrypted copy of the credential envelope, provider/installation metadata, retry state, and a short worker lease. The unique tenant/installation index makes enqueue idempotent; the due/lease index supports atomic claims. Only the authenticated installation owner can enqueue. Worker scan, claim, installation-state check, completion, and retry methods require explicit system context. Completion clears ciphertext; retry retains it until success or dead-letter status. The collection is registered with model creation and tenant index migration.
