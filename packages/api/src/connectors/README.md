# Connector policy

This directory contains provider-neutral connector contracts and policy.

## Authorization

`authorizeConnectorInvocation` is a pure policy decision. Its context must be assembled from trusted server-side authentication, tenant membership, and role/permission data. Never construct it from tool arguments or client-supplied tenant/owner identifiers.

The helper is not yet wired into MCP or Agent execution. Until the integration point is implemented and tested, it is a contract and testable policy primitive—not an enforcement boundary. The next step is to resolve connector installation records through a tenant-scoped repository and call this policy before resolving credentials or executing tools.

## Scope

- Tenant membership is required for both personal and tenant-shared installations.
- Personal installations are owner-only unless the principal has an explicit grant.
- Tenant-shared installations require a tenant-level invocation permission.
- Only installations in the `connected` state may execute.
- Tenant identity mismatch and missing tenant context fail closed.
