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

This guard protects MCP discovery and execution. Google Workspace OAuth now has a provider-neutral adapter contract, a token-endpoint adapter, a tenant-bound orchestration service, and authenticated HTTP initiation/status routes plus a public state-correlated callback. The callback consumes a durable one-time state record, restores the trusted tenant/principal context, exchanges the authorization code with S256 PKCE, and writes tokens only through ConnectorCredentialVault. The start and callback endpoints are rate-limited; the status endpoint returns only safe installation metadata. Express endpoints are mounted under `/api/connectors`: `POST /google-workspace/:installationId/authorize` (JWT + same-origin), `GET /google-workspace/callback` (public, one-time state), and `GET /google-workspace/:installationId/status` (JWT, owner-only). The configured redirect URI must exactly equal the callback URL.

## Protected credential vault

Connector credentials are stored in the separate `connectorcredentials` collection, never in the connector installation document. The persistence layer stores only an encrypted envelope and safe metadata. Ciphertext is excluded from ordinary Mongoose projections; the internal ciphertext read method is intended to be called only inside `ConnectorCredentialVault.withCredentials()` after `ConnectorService.execute()` has authorized and audited the caller.

New connector secrets use AES-256-GCM with a fresh 96-bit nonce per write. The tenant ID, installation ID, and provider are authenticated as additional data, so ciphertext cannot be transplanted between tenants, installations, or providers. Authentication-tag failure is fatal; there is no plaintext or legacy-cipher fallback. Payloads are limited to 64 KiB. The dedicated `CONNECTOR_CREDENTIALS_KEY` must be a 32-byte hexadecimal key supplied by the deployment secret manager; generate a value with `openssl rand -hex 32`. Do not commit the key or log it. Do not reuse `CREDS_KEY`.

The new credential collection is included in the tenant index migration. Installation revocation marks the installation revoked before deleting its encrypted credential row; if cleanup fails, the revoked installation remains unusable and cleanup can be retried. Owner-only writes and deletes derive the owner from trusted request context. Authorized reads are tenant-scoped and are only exposed through the vault service. The initialized application service exposes the vault internally through `require('./initializeMCPs').getConnectorCredentialVault()` after MCP initialization. Provider adapters should use `storeCredentials()` for owner setup and `withCredentials()` for every provider request; they must never return credential values in tool results, model context, or logs.

## Provider OAuth adapter foundation

`oauth/types.ts` defines a provider-neutral token lifecycle contract. `GoogleWorkspaceOAuthAdapter` uses Google's fixed token and revocation endpoints and supports authorization-code exchange (including optional PKCE verifier), refresh-token exchange, and token revocation. It requires a refresh token on initial authorization so the connection can operate offline; refresh responses that omit a rotated refresh token leave preservation of the existing token to the caller. Provider response bodies are not propagated into errors, requests have bounded timeouts, and client credentials are supplied by server configuration rather than returned to the model. The adapter is exported from the `@librechat/api` connector module.

The token adapter is composed with `GoogleWorkspaceOAuthFlow` and the production initialization service. OAuth endpoints are mounted at `POST /api/connectors/google-workspace/:installationId/authorize` (authenticated, same-origin) and `GET /api/connectors/google-workspace/callback` (public callback correlated only by one-time state). The redirect URI is fixed by `GOOGLE_WORKSPACE_REDIRECT_URI`; scopes are explicitly configured with `GOOGLE_WORKSPACE_SCOPES` and must be reviewed for least privilege. The owner-only status endpoint is `GET /api/connectors/google-workspace/:installationId/status`; it returns only safe installation metadata. The API returns the authorization URL to the authenticated caller. The MCP Servers side panel's Google Workspace connection manager creates and lists owner-scoped installations, starts OAuth, displays safe connection state, supports reauthorization, and disconnects accounts. Never put OAuth codes, QR pairing payloads, or WhatsApp session material in connector installation records.


## Google Workspace OAuth connection orchestration

`oauth/GoogleWorkspaceOAuthFlow` builds the Google authorization URL with offline access and S256 PKCE, generates high-entropy state, stores only its SHA-256 hash through an injected one-time state store, and captures the initiating tenant/principal/installation/redirect URI/verifier with a ten-minute expiry. Callback completion atomically consumes state, restores the captured trusted tenant/principal context for every tenant-scoped read/write, rechecks installation ownership and revocation, exchanges the code with the verifier, stores tokens through the encrypted credential vault, and advances the installation lifecycle using its version. A failed callback attempts to mark the installation as errored without exposing provider details.

Production wiring now uses a MongoDB `GoogleOAuthState` collection with a unique SHA-256 state-hash index, TTL index, and atomic `findOneAndDelete` consume. The PKCE verifier is AES-256-GCM encrypted under the independent `CONNECTOR_OAUTH_STATE_KEY`, with tenant, principal, installation, and state hash bound as authenticated metadata. State creation verifies that the supplied identity matches trusted tenant AsyncLocalStorage context. Callback completion restores the captured context; provider cancellation consumes the state and marks the installation as errored. The callback never accepts tenant or principal IDs. The raw state appears only in the Google authorization URL and callback URL. Configure `CONNECTOR_OAUTH_STATE_KEY`, `GOOGLE_WORKSPACE_CLIENT_ID`, `GOOGLE_WORKSPACE_CLIENT_SECRET`, `GOOGLE_WORKSPACE_REDIRECT_URI`, and explicit `GOOGLE_WORKSPACE_SCOPES` in the deployment secret/configuration system. The browser UI and provider API tools are not included in this milestone; tests are authored but have not been executed in a dependency-enabled environment.


## Google Workspace token lifecycle and disconnect

`GoogleWorkspaceTokenLifecycle` composes the Google token adapter, the encrypted credential vault, and connector installation persistence. Access-token retrieval refreshes credentials only when they are within a two-minute expiry safety window. The refresh path uses an atomic MongoDB lease stored alongside the encrypted credential row; the lease token fences writes so a process whose lease expired cannot overwrite a newer token pair. The lease is cross-process, not an in-memory mutex. After acquiring it, the service re-reads credentials through a fresh authorized vault operation before refreshing.

Google commonly omits `refresh_token` from refresh responses. In that case, the existing refresh token is preserved. If Google rotates the refresh token, the replacement is persisted with the new access token in the same encrypted vault write. A safe machine-readable `invalid_grant` error marks the installation `error` with `google_reauthorization_required`; provider descriptions and response bodies are not exposed. Concurrent requests wait briefly for the lease holder and then re-read the current token pair.

The owner-only, authenticated, same-origin disconnect endpoint is `DELETE /api/connectors/google-workspace/:installationId/disconnect`. It attempts Google remote revocation using the refresh token (or access token as a fallback), then revokes the local installation and deletes the encrypted credential row. Local access is disabled even when Google's revocation endpoint is unavailable; the response distinguishes `remoteRevocation: confirmed` from `pending`. Repeated local disconnect requests are safe and can retry encrypted-row cleanup after an earlier cleanup failure. A pending remote revocation means the provider token may remain valid until Google invalidates it or it expires; local connector access is nevertheless blocked.

Focused tests are authored for token refresh, refresh-token preservation, cross-process lease contention, stale-lease write fencing, invalid-grant handling, remote revocation failure, and owner-only disconnect routes. They have not been executed in a dependency-enabled checkout.


## Google Drive read-only metadata connector

`GoogleDriveReadOnlyConnector` is the first provider API adapter. It uses the existing `ConnectorService`, `ConnectorCredentialVault`, and `GoogleWorkspaceTokenLifecycle`; it does not create a second token store or accept caller-supplied tenant/principal identities. Each request is authorized and audited before scope inspection, token retrieval, or Google API dispatch. Token refresh remains just-in-time and uses the existing distributed refresh lease.

The connector supports only:
- List/search Drive files with the Drive `files.list` endpoint.
- Retrieve metadata for one file with `files.get`.

It requests only metadata fields (ID, name, MIME type, modification time, size, web/icon links, parents, and trashed flag). It does not expose file download, export, upload, update, delete, or permission mutation operations. Requests use GET, a fixed Google API origin, a ten-second timeout, a maximum page size of 100, bounded query/page-token lengths, and safe provider errors. Search always excludes trashed files. Returned records are allowlisted rather than passing arbitrary Google response properties to callers.

The exact least-privilege OAuth scope is:
`https://www.googleapis.com/auth/drive.metadata.readonly`

Add this scope to `GOOGLE_WORKSPACE_SCOPES` before authorizing Drive access. The adapter checks the actual granted scope stored with the encrypted credentials on every operation; a configured scope alone is not treated as proof of consent. If the existing connection lacks it, reconnect and grant the additional scope. Avoid broad scopes such as `drive` or `drive.readonly` for this metadata-only milestone.

Authenticated API routes (mounted under `/api/connectors`):
- `GET /google-workspace/:installationId/drive/files?q=...&pageSize=...&pageToken=...`
- `GET /google-workspace/:installationId/drive/files/:fileId`

Both routes return metadata only and set no-store headers. The connector service performs tenant, membership, installation-state, owner/grant, and tenant-shared role checks; failures do not reach Google. The built-in `google_drive` agent/assistant tool is also registered in the existing LibreChat tool manifest, schema registry, and runtime loader. It exposes `search_files` and `get_file_metadata` only. No Drive file content is returned.

Focused tests cover listing, metadata retrieval, scope denial, authorization-before-provider-call, pagination validation, safe provider errors, and HTTP route behavior. Tests are authored but have not been executed in a dependency-enabled checkout.


## Google Workspace installation management and model tools

Authenticated owner-scoped routes now create and list personal Google Workspace installations:
- `POST /api/connectors/google-workspace` creates a disconnected installation from a display name; owner and tenant are derived from trusted request context.
- `GET /api/connectors/google-workspace` lists only the current principal's installations in the active tenant and returns safe metadata only.
- The existing `POST /api/connectors/google-workspace/:installationId/authorize` starts OAuth for that installation.

The MCP Servers side panel includes a Google Workspace connection manager. It creates an installation, starts Google OAuth, displays connection state, supports reauthorization, and disconnects accounts. The OAuth callback redirects to the client with a one-time UI result marker; no tokens or OAuth state are exposed in the UI.

The built-in `google_drive` agent/assistant tool is registered through LibreChat's manifest, tool-definition registry, and existing runtime loader. Its actions are `search_files` and `get_file_metadata`. It selects the sole connected personal account automatically, or returns safe account IDs/names for explicit selection when multiple accounts are connected. The selected installation ID is never treated as authorization: the connector service rechecks trusted tenant, membership, installation state, owner/grant, and tenant role at invocation time. Tool output contains only allowlisted metadata and safe error messages. The tool is read-only and does not provide content download/export, upload, edit, delete, or sharing operations.

Tests have been authored for installation list/create routes, Google Drive tool account selection, metadata lookup, and provider error redaction. They have not been executed in a dependency-enabled checkout.
