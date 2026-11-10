import { useCallback, useEffect, useState } from 'react';

interface GoogleWorkspaceInstallation {
  id: string;
  displayName: string;
  state: string;
  lastConnectedAt?: string | null;
  lastErrorCode?: string | null;
  grantedPrincipalIds?: string[];
  version: number;
}

interface InstallationsResponse {
  installations: GoogleWorkspaceInstallation[];
}

interface TenantMember {
  id: string;
  name: string | null;
  username: string | null;
  email: string;
}

interface TenantMembersResponse {
  members: TenantMember[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(response.status === 403
      ? 'You do not have permission to manage this connection.'
      : response.status === 409
        ? 'Sharing changed elsewhere. Refresh the connection list and try again.'
        : 'Google Workspace could not complete the request. Please try again.');
  }
  return response.json() as Promise<T>;
}

export default function GoogleWorkspaceConnections() {
  const [installations, setInstallations] = useState<GoogleWorkspaceInstallation[]>([]);
  const [displayName, setDisplayName] = useState('Google Workspace');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [grantDrafts, setGrantDrafts] = useState<Record<string, string[]>>({});
  const [memberQueries, setMemberQueries] = useState<Record<string, string>>({});
  const [memberResults, setMemberResults] = useState<Record<string, TenantMember[]>>({});
  const [memberSearchBusyId, setMemberSearchBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/connectors/google-workspace', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await readJson<InstallationsResponse>(response);
      setInstallations(data.installations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Google Workspace connections.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const url = new URL(window.location.href);
    const result = url.searchParams.get('googleWorkspace');
    if (result === 'connected') {
      setMessage('Google Workspace connected successfully.');
      url.searchParams.delete('googleWorkspace');
      window.history.replaceState({}, '', url.toString());
    } else if (result === 'failed') {
      setError('Google authorization did not complete. You can safely try again.');
      url.searchParams.delete('googleWorkspace');
      window.history.replaceState({}, '', url.toString());
    }
  }, [refresh]);

  const authorize = async (installationId: string) => {
    setBusyId(installationId);
    setError(null);
    try {
      const response = await fetch(`/api/connectors/google-workspace/${encodeURIComponent(installationId)}/authorize`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await readJson<{ authorizationUrl: string }>(response);
      const target = new URL(data.authorizationUrl);
      if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com') {
        throw new Error('Google returned an unexpected authorization destination.');
      }
      window.location.assign(target.toString());
    } catch (err) {
      await refresh();
      setError(err instanceof Error ? err.message : 'Unable to start Google authorization.');
      setBusyId(null);
    }
  };

  const createAndAuthorize = async () => {
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/connectors/google-workspace', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      const installation = await readJson<{ id: string }>(response);
      await authorize(installation.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create Google Workspace connection.');
    } finally {
      setCreating(false);
    }
  };

  const searchMembers = async (installation: GoogleWorkspaceInstallation) => {
    const query = (memberQueries[installation.id] ?? '').trim();
    if (query.length < 2 || query.length > 64) {
      setError('Enter at least 2 characters to search tenant members.');
      return;
    }
    setMemberSearchBusyId(installation.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/connectors/google-workspace/${encodeURIComponent(installation.id)}/members?q=${encodeURIComponent(query)}`,
        { credentials: 'include', headers: { Accept: 'application/json' }, cache: 'no-store' },
      );
      const data = await readJson<TenantMembersResponse>(response);
      setMemberResults((current) => ({ ...current, [installation.id]: data.members }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to search tenant members.');
    } finally {
      setMemberSearchBusyId(null);
    }
  };

  const toggleGrant = (installation: GoogleWorkspaceInstallation, memberId: string, checked: boolean) => {
    const current = grantDrafts[installation.id] ?? installation.grantedPrincipalIds ?? [];
    const next = checked ? [...new Set([...current, memberId])] : current.filter((id) => id !== memberId);
    setGrantDrafts((drafts) => ({ ...drafts, [installation.id]: next }));
  };

  const saveGrants = async (installation: GoogleWorkspaceInstallation) => {
    setBusyId(installation.id);
    setError(null);
    setMessage(null);
    const principalIds = grantDrafts[installation.id] ?? installation.grantedPrincipalIds ?? [];
    try {
      const response = await fetch(
        `/api/connectors/google-workspace/${encodeURIComponent(installation.id)}/grants`,
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ expectedVersion: installation.version, principalIds }),
        },
      );
      await readJson<{ version: number }>(response);
      setMessage('Connector sharing permissions updated.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update connector sharing permissions.');
    } finally {
      setBusyId(null);
    }
  };

  const checkHealth = async (installationId: string) => {
    setBusyId(installationId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/connectors/google-workspace/${encodeURIComponent(installationId)}/health-check`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        },
      );
      const result = await readJson<{
        healthy: boolean;
        state: string;
        consecutiveFailures: number;
        errorCode: string | null;
      }>(response);
      setMessage(result.healthy
        ? 'Google Workspace connection check succeeded.'
        : `Google Workspace is temporarily unhealthy (${result.errorCode ?? 'provider_error'}). Consecutive failures: ${result.consecutiveFailures}.`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to check Google Workspace connection.');
    } finally {
      setBusyId(null);
    }
  };

  const disconnect = async (installationId: string) => {
    setBusyId(installationId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/connectors/google-workspace/${encodeURIComponent(installationId)}/disconnect`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const result = await readJson<{ remoteRevocation: 'confirmed' | 'pending' | 'not_attempted' }>(response);
      setMessage(result.remoteRevocation === 'confirmed'
        ? 'Google Workspace disconnected and remote revocation confirmed.'
        : result.remoteRevocation === 'pending'
          ? 'Local access is disabled. Google remote revocation has been queued or is awaiting retry.'
          : 'Local access is disabled, but remote revocation could not be queued or attempted. Contact an administrator.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to disconnect Google Workspace.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="mb-3 rounded-lg border border-border-light p-3" aria-labelledby="google-workspace-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 id="google-workspace-title" className="text-sm font-semibold text-text-primary">Google Workspace</h3>
          <p className="text-xs text-text-secondary">Connect Drive for read-only file search and metadata.</p>
        </div>
        <span className="text-xs text-text-secondary">{installations.length} saved connection(s)</span>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="google-workspace-name">Connection name</label>
        <input
          id="google-workspace-name"
          className="min-w-0 flex-1 rounded-md border border-border-medium bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
          value={displayName}
          maxLength={120}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <button
          type="button"
          className="rounded-md bg-surface-secondary px-3 py-1.5 text-sm font-medium text-text-primary disabled:opacity-50"
          disabled={creating || !displayName.trim()}
          onClick={() => void createAndAuthorize()}
        >
          {creating ? 'Starting…' : 'Connect Google'}
        </button>
      </div>
      {loading ? <p className="text-xs text-text-secondary">Loading connections…</p> : null}
      {!loading && installations.length === 0 ? (
        <p className="text-xs text-text-secondary">No Google Workspace accounts connected yet.</p>
      ) : null}
      <ul className="space-y-2">
        {installations.map((installation) => (
          <li key={installation.id} className="flex flex-col items-stretch gap-3 rounded-md bg-surface-secondary px-2.5 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-text-primary">{installation.displayName}</p>
              <p className="text-xs text-text-secondary">
                {installation.state.replaceAll('_', ' ')}
                {installation.lastErrorCode ? ` · ${installation.lastErrorCode}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {installation.state !== 'connected' && installation.state !== 'revoked' ? (
                <button
                  type="button"
                  className="text-xs font-medium text-text-primary underline disabled:opacity-50"
                  disabled={busyId === installation.id}
                  onClick={() => void authorize(installation.id)}
                >
                  {busyId === installation.id ? 'Working…' : 'Authorize'}
                </button>
              ) : null}
              {installation.state !== 'revoked' ? (
                <button
                  type="button"
                  className="text-xs font-medium text-text-secondary underline disabled:opacity-50"
                  disabled={busyId === installation.id}
                  onClick={() => void disconnect(installation.id)}
                >
                  {busyId === installation.id ? 'Working…' : installation.state === 'connected' ? 'Disconnect' : 'Remove'}
                </button>
              ) : null}
            </div>
            {installation.state !== 'revoked' ? (
              <div className="mt-2 w-full rounded-md border border-border-medium p-2">
                <label className="mb-1 block text-xs font-medium text-text-secondary" htmlFor={`connector-member-search-${installation.id}`}>
                  Find tenant members by name, username, or email
                </label>
                <div className="flex gap-2">
                  <input
                    id={`connector-member-search-${installation.id}`}
                    className="min-w-0 flex-1 rounded-md border border-border-medium bg-surface-primary px-2 py-1 text-xs text-text-primary"
                    value={memberQueries[installation.id] ?? ''}
                    onChange={(event) => setMemberQueries((current) => ({ ...current, [installation.id]: event.target.value }))}
                    placeholder="Search members…"
                    maxLength={64}
                  />
                  <button
                    type="button"
                    className="text-xs font-medium text-text-primary underline disabled:opacity-50"
                    disabled={memberSearchBusyId === installation.id}
                    onClick={() => void searchMembers(installation)}
                  >
                    {memberSearchBusyId === installation.id ? 'Searching…' : 'Find'}
                  </button>
                </div>
                {(memberResults[installation.id] ?? []).length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {(memberResults[installation.id] ?? []).map((member) => {
                      const selected = (grantDrafts[installation.id] ?? installation.grantedPrincipalIds ?? []).includes(member.id);
                      return (
                        <li key={member.id}>
                          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-primary">
                            <input type="checkbox" checked={selected} onChange={(event) => toggleGrant(installation, member.id, event.target.checked)} />
                            <span className="min-w-0">
                              <span className="block truncate">{member.name || member.username || member.email}</span>
                              <span className="block truncate text-text-secondary">{member.email}</span>
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : memberResults[installation.id] ? (
                  <p className="mt-2 text-xs text-text-secondary">No matching tenant members found.</p>
                ) : null}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-text-secondary">{(grantDrafts[installation.id] ?? installation.grantedPrincipalIds ?? []).length} people selected</span>
                  <button type="button" className="text-xs font-medium text-text-primary underline disabled:opacity-50" disabled={busyId === installation.id} onClick={() => void saveGrants(installation)}>
                    Save sharing
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {message ? <p role="status" className="mt-2 text-xs text-text-secondary">{message}</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-red-500">{error}</p> : null}
      <p className="mt-2 text-[11px] text-text-secondary">
        Drive access is metadata-only. Google may ask you to approve the Drive metadata read-only permission.
      </p>
    </section>
  );
}
