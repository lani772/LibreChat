# SaaS AI Workspace — Architecture and Delivery Plan

## Status

- Repository: `lani772/LibreChat`
- Development branch: `feat/saas-mcp-platform-foundation`
- Base: `main` (the fork's `dev` branch was not available when work began)
- Upstream baseline inspected: `f4154b649efa37e1345ccc517a4d8d1ed2178c82`
- This document records the first implementation milestone. It is not a claim that the SaaS features below are already implemented.

## Product objective

Evolve this LibreChat fork into a multi-tenant AI workspace where each organization can manage members, AI agents, skills, and approved integrations. Users should be able to invoke connected business systems from chat and agent workflows through a consistent, permission-checked tool experience.

Initial integration targets:

- Google Workspace (starting with least-privilege OAuth scopes and selected services)
- Chatwoot
- n8n
- WhatsApp, using the existing Go bridge + Python MCP server project as a separately operated integration where appropriate

The product must support both remote MCP servers and first-party integrations. These are related but not identical deployment models and must not be forced into one implementation.

## Architecture decisions

### Preserve the LibreChat foundation

The current repository already provides:

- React + TypeScript client and shared UI packages
- Node.js + Express 5 server and TypeScript backend services
- MongoDB + Mongoose persistence
- MCP client support using the official MCP TypeScript SDK
- Agent runtime and Skills infrastructure
- Authentication, OIDC, role/permission checks, and tenant-context utilities
- Redis-backed coordination and background infrastructure
- OpenAPI/Swagger generation

The first delivery should extend these systems. Do not introduce a second authentication service, duplicate agent runtime, separate MCP manager, Fastify backend, or PostgreSQL migration without a demonstrated requirement and an approved migration plan.

### Integration execution models

1. **Remote MCP server** — connect to a separately hosted MCP endpoint using the existing MCP transport, authentication, discovery, and tool execution lifecycle.
2. **First-party API connector** — a LibreChat-owned adapter calls a provider API directly. It must expose a narrow, typed tool surface and use the same authorization, consent, audit, and error-handling standards as MCP tools.
3. **External MCP bridge** — a separately deployed service (for example, the Go/Python WhatsApp MCP server) exposes an authenticated MCP endpoint. LibreChat stores only the connector configuration and protected credentials required to connect; it must not absorb that service's private session secrets.

A connector catalog may describe all three models, but catalog metadata must not itself grant access or execute a tool.

### Tenant and principal security model

Every request must be authorized from trusted server-side identity and tenant context. Never accept a tenant ID, owner ID, account ID, or permission claim supplied only as a model-controlled tool argument.

The authorization chain for a tool call is:

1. Resolve the authenticated principal from the existing authentication middleware.
2. Resolve the active tenant from trusted server context.
3. Resolve the connector installation and its owner/visibility scope.
4. Check tenant membership, role grants, resource-level permissions, and consent.
5. Resolve credentials on the server; do not return access tokens or refresh tokens to the model.
6. Validate tool arguments against the connector's schema and policy.
7. Execute with bounded timeouts, cancellation, rate limits, and safe retry rules.
8. Return a minimized, structured result and write a redacted audit event.

Tenant isolation and user ownership are separate checks. A tenant-scoped connector may be shared with selected members, while a personal connector must remain private to its owner unless explicitly shared under a supported permission model. Cross-tenant access must fail closed.

### Connector lifecycle

A connector installation needs a stable internal ID and, at minimum, these lifecycle states:

- `disconnected`
- `authorizing`
- `connected`
- `degraded`
- `revoked`
- `error`

State transitions must be explicit and observable. Credential rotation, disconnect, tenant membership changes, and permission revocation must invalidate cached access and prevent subsequent tool calls. Secrets must be encrypted at rest using the repository's established secret-handling facilities; encryption keys must not be stored beside ciphertext. Logs and audit events must never contain credentials, OAuth codes, QR pairing material, or message contents unless a separately approved data policy explicitly requires them.

## Repository findings that shape implementation

- `packages/api/src/mcp/MCPManager.ts` is the current central MCP manager and contains substantial discovery, tool execution, OAuth recovery, and lifecycle behavior.
- `packages/api/src/mcp/UserConnectionManager.ts` manages principal-specific MCP connections and their in-flight lifecycle.
- `packages/api/src/mcp/ConnectionsRepository.ts` owns connection loading and teardown for an owner scope.
- `packages/api/src/mcp/registry/MCPServersRegistry.ts` resolves server configuration and caches encrypted configuration representations.
- `packages/api/src/mcp/capabilities.ts` defines connection capability profiles and connection-pool keys.
- `api/server/routes/mcp.js` is Express route wiring for MCP management and OAuth; new backend behavior belongs in `packages/api`, not as new business logic in this legacy CJS route file.
- `packages/data-schemas/src/tenant/policy.ts` contains engine-neutral tenant policy; `packages/data-schemas/src/models/plugins/tenantIsolation.ts` binds it to Mongoose.
- Existing MCP user-connection pool keys include principal, server name, and capability profile. The relationship between those keys and tenant identity must be audited before relying on them for a multi-tenant connector registry.
- The repository's `AGENTS.md` explicitly advises dependency injection for new backend behavior and says not to extend the existing static MCP singletons as a design pattern.

These findings mean that the current MCP support is a foundation, not proof that the full organization-level SaaS permission model is already complete.

## Delivery sequence

### Milestone 0 — Baseline and invariants

- Confirm the exact branch/base and inspect repository guidance.
- Map auth, tenant context, user/organization membership, roles, MCP config storage, OAuth token storage, audit facilities, and existing tests.
- Identify where identity is user-scoped versus tenant-scoped.
- Record baseline test and typecheck results from an environment with dependencies and required services available.

### Milestone 1 — Connector contracts and authorization boundary

- Define typed connector metadata, installation identity, visibility, lifecycle state, supported auth mode, and tool declarations.
- Define a dependency-injected connector runtime interface; do not extend the MCP singleton to implement first-party providers.
- Define one server-side authorization function used by chat, agents, and any future automation entry points.
- Add unit tests for tenant mismatch, owner mismatch, revoked membership, denied permission, and safe error mapping.
- Keep connector metadata separate from credentials and execution state.

### Milestone 2 — Persisted installations and catalog

- [x] Inspect existing schema and migration conventions.
- [x] Add a tenant-scoped ConnectorInstallation model with stable MongoDB IDs and opaque instance keys.
- [x] Derive installation ownership from authenticated tenant context rather than caller-supplied owner IDs.
- [x] Register the model and data methods; include the collection in tenant index migration.
- [x] Add version-checked lifecycle transitions and a revocation operation.
- [ ] Add the service/API authorization boundary, credential adapter, audit events, cache invalidation, and provider-specific revoke behavior.
- Provider credentials remain outside this collection; the opaque credential reference is not yet backed by a completed connector credential adapter.

### Milestone 3 — First-party connector vertical slice

- Select one provider and one narrow read-only workflow first.
- Implement OAuth or provider authentication with minimum scopes.
- Add typed input/output schemas, server-side credential resolution, pagination/limits, timeout/cancellation, and redacted errors.
- Expose the tool through the existing agent/tool execution path.
- Add integration tests with mocked provider responses and authorization tests across two tenants.

### Milestone 4 — External MCP and bridge integrations

- Add connector catalog UX for approved remote MCP endpoints.
- Preserve the existing MCP transport and OAuth implementation.
- Support a separately hosted Go/Python WhatsApp bridge without exposing WhatsApp session secrets to the model.
- Test tool routing, revocation, reconnect, concurrent accounts, and cross-tenant denial.

### Milestone 5 — Organization administration and operational readiness

- Add organization membership and role-management UI only after the existing tenant and role model is fully mapped.
- Add usage limits, quotas, connector health, and admin audit views.
- Add deployment, backup, secret rotation, monitoring, and incident-response documentation.
- Run focused tests, workspace typechecks, lint/static checks, and end-to-end tests on the exact pushed head.

### Milestone 2.5 — Connector-to-MCP authorization binding

- [x] Bind connector installations to stable MCPServer database IDs with owner verification and a tenant-scoped unique index.
- [x] Add a dependency-injected guard that resolves installations only from trusted ParsedServerConfig.dbId.
- [x] Inject the guard into the existing MCPManager without capturing tenant or user identity in the process-wide singleton.
- [x] Enforce authorization before tool-catalog discovery, before connection checkout, and again immediately before upstream tool dispatch/retry.
- [x] Preserve ordinary unbound MCP server behavior.
- [x] Add focused guard tests and MCPManager boundary tests.
- [x] Use the existing tenant-isolated User lookup to verify membership and the existing hash-chained audit writer for authorization events.
- [x] Add `MCP_SERVERS.INVOKE_CONNECTORS` to LibreChat's existing role permission schema, typed role model, and role defaults. It is separate from general MCP server use; USER defaults to denied and ADMIN defaults to allowed.
- [x] Expose the permission in the existing MCP role settings UI and validate updates with the existing MCP permission schema.
- [x] Resolve the authenticated user's current tenant role on every authorization check without shared role-cache reads; permission changes apply to the next discovery/tool call.
- [x] Backfill the new permission on existing tenant copies of the built-in ADMIN/USER roles using tenant-partitioned updates; custom roles with no explicit grant remain denied.
- [x] Add focused tests for allowed/denied roles, missing/malformed role data, cross-tenant users, lookup failures, and immediate permission revocation.
- [x] Add a tenant-isolated connector credential collection with encrypted-payload-only storage and owner-derived writes/deletes.
- [x] Encrypt new credentials using AES-256-GCM with a dedicated `CONNECTOR_CREDENTIALS_KEY`, random nonce, authentication tag, and tenant/installation/provider AAD.
- [x] Add an authorized vault service that decrypts only inside `ConnectorService.execute()` after authorization and durable audit.
- [x] Delete encrypted credential rows when an installation is revoked; include the collection in tenant index migration.
- [x] Add tests for authenticated encryption, tamper detection, context binding, size limits, owner checks, tenant isolation, authorized reads, and revocation cleanup.
- [ ] Implement KMS/HSM-backed key management and automated key rotation/re-encryption.
- [ ] Implement provider OAuth refresh/revocation and concrete provider adapters.
- [ ] Run the focused Jest suites, package typechecks, lint, and integration tests in a configured checkout.
- [ ] Run the focused Jest suites, package typechecks, lint, and integration tests in a configured checkout.

The connector credential persistence and vault service are now implemented on the feature branch. New credentials use AES-256-GCM and a dedicated `CONNECTOR_CREDENTIALS_KEY`; no plaintext is written to MongoDB. KMS/HSM integration, automated key rotation, provider token refresh/revocation, and provider-specific adapters remain outstanding. Tests are authored but have not been executed in this environment. The runtime guard and tenant-role permission resolver are committed on the feature branch. Test files have been authored but have not been executed in this environment. Tenant-shared connectors require `MCP_SERVERS.INVOKE_CONNECTORS`; general `MCP_SERVERS.USE` does not grant connector invocation. The resolver performs uncached tenant-partition role reads on every check. Personal-owner and explicit-grant checks still require the principal to be present in the active tenant partition.

## Acceptance criteria

A milestone is complete only when code and tests demonstrate the behavior. At minimum, the platform must prove:

- Two tenants cannot read, invoke, update, or revoke each other's connector installations.
- Two users in one tenant cannot invoke a personal connector owned by the other without an explicit grant.
- A revoked member or credential cannot continue using cached tools or sessions.
- A tool call cannot override tenant, owner, or permission identity through its arguments.
- Concurrent connect/disconnect and tool calls do not leak connections or credentials between principals.
- Provider errors, logs, traces, and model-visible results do not expose secrets.
- Existing LibreChat MCP, Agents, Skills, and single-user flows remain regression-tested.

## Verification notes

GitHub Actions runs and commit status checks were not returned for the baseline commit during the initial check. No local test suite has yet been executed in this environment. Do not interpret missing CI records as a passing test result. Each implementation milestone must report exact commands, actual results, and any checks that could not run.
