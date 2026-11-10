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

New connector secrets use AES-256-GCM with a fresh 96-bit nonce per write. The tenant ID, installation ID, and provider are authenticated as additional data, so ciphertext cannot be transplanted between tenants, installations, or providers. Authentication-tag failure is fatal; there is no plaintext or legacy-cipher fallback. Payloads are limited to 64 KiB. New deployments should use a versioned keyring supplied by the deployment secret manager:
- `CONNECTOR_CREDENTIALS_KEYRING`: JSON object mapping key IDs to 64-character hexadecimal AES-256 keys (maximum 20 keys).
- `CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID`: key ID used for new writes.
- `CONNECTOR_CREDENTIALS_KEY`: legacy key retained only to decrypt older envelopes that do not carry a key ID.

Generate independent keys with `openssl rand -hex 32`. Do not commit keys, reuse `CREDS_KEY`, or log key material. Keep every old key in the keyring until all credentials encrypted under it have been migrated. Legacy envelopes still require the old `CONNECTOR_CREDENTIALS_KEY` until migration is complete.

The new credential collection is included in the tenant index migration. Installation revocation marks the installation revoked before deleting its encrypted credential row; if cleanup fails, the revoked installation remains unusable and cleanup can be retried. Owner-only writes and deletes derive the owner from trusted request context. Authorized reads are tenant-scoped and are only exposed through the vault service. The initialized application service exposes the vault internally through `require('./initializeMCPs').getConnectorCredentialVault()` after MCP initialization. Provider adapters should use `storeCredentials()` for owner setup and `withCredentials()` for every provider request; they must never return credential values in tool results, model context, or logs.

## Credential key rotation operation

A bounded maintenance command is provided at `api/rotate-connector-credentials.js` (npm script: `npm --prefix api run rotate-connector-credentials -- ...`). It is deliberately not an HTTP endpoint.

Safe rollout:
1. Back up the database and store the new keyring in the deployment secret manager.
2. Deploy every application instance with the same keyring and active key ID. Keep the legacy `CONNECTOR_CREDENTIALS_KEY` and all historical key IDs available. Do not run the migration while old application instances can still write using the legacy single-key configuration.
3. Run a dry run first: `npm --prefix api run rotate-connector-credentials -- --dry-run --batch-size=50 --max-batches=10`.
4. Review the summary, then apply: `npm --prefix api run rotate-connector-credentials -- --apply --batch-size=50 --max-batches=10`.
5. If `complete` is false, rerun with the returned `resumeAfterId`: `--after=<resumeAfterId>`. Repeat until the command reports `complete: true`, `failed: 0`, and no outstanding conflicts after a final full scan.
6. Only after a verified complete scan and backup-retention window may the legacy key be removed. Keep older key IDs until no stored envelope refers to them.

The command defaults to dry-run; `--apply` is required to write. It accepts batches of 1–100 rows and at most 100 batches per invocation. The database scan and compare-and-set replacement methods independently require explicit system tenant context. Rows with active token-refresh leases are skipped. Replacement compares the original ciphertext and `updatedAt`, so a concurrent refresh/write is not overwritten; conflicts are counted and must be checked on a subsequent scan. An undecryptable row stops the run without logging plaintext, ciphertext, provider tokens, or the row ID; correct the key configuration and resume from the last safe cursor. The job can be rerun safely because envelopes already using the active key ID are skipped.

This is an application-level rotation workflow, not KMS/HSM custody. Production key storage, access controls, key backup, approval, and emergency recovery remain responsibilities of the deployment secret manager and operator process.

## Durable remote revocation

Google Workspace disconnect first copies the existing encrypted credential envelope into the tenant-isolated `connectorrevocations` outbox, then revokes the local installation and deletes the ordinary credential row. The copied value remains AES-256-GCM ciphertext and is bound to the same tenant, installation, and provider AAD; plaintext tokens are never written to the outbox.

A background worker claims jobs with an atomic lease, verifies the installation is locally revoked, decrypts the payload only in the worker, and calls Google's fixed revocation endpoint. Successful jobs clear the encrypted payload. Failures use bounded exponential backoff (30 seconds up to six hours) and move to a `dead` state after the configured attempt limit. MongoDB leases coordinate multiple API replicas. The worker emits aggregate counts and safe error codes only.

The worker starts only when Google Workspace OAuth is configured and its collection indexes have been created. The disconnect API reports `pending` while a durable job is queued or awaiting retry, `confirmed` only for the immediate fallback path when enqueueing fails but Google's revoke call succeeds, `not_attempted` when no token was available, and `retry_unavailable` when durable enqueue and the immediate fallback both fail. If the outbox is unavailable, the service makes one immediate best-effort revoke attempt before local credential cleanup; a failed fallback cannot be retried durably and must be treated as an operational alert. Dead jobs retain ciphertext for operator investigation and must be handled under the same key-access controls as credential records.

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


## Connector credential key rotation

The AES-256-GCM envelope now supports a key ID while retaining decryption compatibility with existing `gcm1` envelopes that do not contain one.

For a multi-key deployment, configure:
- `CONNECTOR_CREDENTIALS_KEYRING`: JSON object mapping key IDs to 32-byte hexadecimal keys (maximum 20 keys).
- `CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID`: key ID used for all new credential writes.
- `CONNECTOR_CREDENTIALS_KEY`: retain the previous single-key value while legacy envelopes without a key ID remain in the database.

Example (use secret-manager values, not these sample keys):

```env
CONNECTOR_CREDENTIALS_KEYRING={"2026-10":"<64-hex-old-key>","2026-11":"<64-hex-new-key>"}
CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID=2026-11
CONNECTOR_CREDENTIALS_KEY=<64-hex-legacy-key>
```

Rotation procedure:
1. Back up the old key securely and add both old and new key IDs to the keyring.
2. Keep `CONNECTOR_CREDENTIALS_KEY` set to the old key for existing envelopes that have no key ID.
3. Set the active key ID to the new key. New writes use that key; decryption continues to use the key ID embedded in newer envelopes.
4. Re-encrypt all remaining legacy credentials under the active key before removing the legacy key. Token refresh writes naturally re-encrypt credentials when they are refreshed, but this alone is not a complete fleet-wide rotation.
5. Verify no stored credential envelopes reference a retired key, then remove that key from the keyring and retire it in the secret manager.

Unknown key IDs, missing keys, malformed keyrings, and authentication-tag failures fail closed. The keyring is a deployment-managed key distribution mechanism, not a KMS/HSM integration: production deployments should source it from a KMS/HSM-backed secret manager and define an audited re-encryption job before retiring keys.
