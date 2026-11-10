import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@librechat/client';

type ConnectorState = 'disconnected' | 'authorizing' | 'connected' | 'degraded' | 'revoked' | 'error';

interface ConnectorInstallation {
  id: string;
  provider: string;
  displayName: string;
  ownerId: string;
  visibility: 'personal' | 'tenant';
  state: ConnectorState;
  grantedPrincipalCount: number;
  mcpServerId: string | null;
  lastConnectedAt: string | null;
  lastHealthCheckAt: string | null;
  lastSuccessfulHealthCheckAt: string | null;
  consecutiveHealthFailures: number;
  lastErrorCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  version: number;
}

interface ConnectorAuditEntry {
  id: string;
  action: string;
  outcome: string;
  severity: string;
  actor: { type: string; id: string | null; name: string };
  target: { type: string; id: string | null; name: string | null };
  timestamp: string;
  metadata: { provider: string | null; reason: string | null };
  integrity: { seq: number; hash: string; prevHash: string };
}

interface InventoryResponse { installations: ConnectorInstallation[] }
interface AuditResponse { entries: ConnectorAuditEntry[]; total: number; nextCursor: number | null }

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 403) throw new Error('Tenant administrator access is required.');
    throw new Error('Connector governance data is unavailable. Please retry.');
  }
  return response.json() as Promise<T>;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export default function ConnectorGovernance() {
  const [installations, setInstallations] = useState<ConnectorInstallation[]>([]);
  const [entries, setEntries] = useState<ConnectorAuditEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [activeView, setActiveView] = useState<'inventory' | 'audit'>('inventory');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalAudit, setTotalAudit] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/connectors/installations', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await readResponse<InventoryResponse>(response);
      setInstallations(data.installations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load connector inventory.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async (cursor?: number, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (cursor != null) query.set('cursor', String(cursor));
      const response = await fetch(`/api/admin/connectors/audit?${query.toString()}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      const data = await readResponse<AuditResponse>(response);
      setEntries((current) => append ? [...current, ...data.entries] : data.entries);
      setTotalAudit(data.total);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load connector audit history.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === 'inventory') void loadInventory();
    else void loadAudit();
  }, [activeView, loadInventory, loadAudit]);

  const filtered = useMemo(() => installations.filter((item) => {
    const query = filter.trim().toLowerCase();
    const matchesQuery = !query || [item.displayName, item.provider, item.ownerId, item.id]
      .some((value) => value.toLowerCase().includes(query));
    return matchesQuery && (stateFilter === 'all' || item.state === stateFilter);
  }), [installations, filter, stateFilter]);

  return (
    <section className="my-3 rounded-xl border border-border-light p-3 dark:border-border-dark" aria-label="Tenant connector governance">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Connector governance</h3>
          <p className="text-xs text-text-secondary">Tenant-wide connection inventory and invocation audit.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => activeView === 'inventory' ? void loadInventory() : void loadAudit()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <div className="mt-3 flex gap-2" role="tablist" aria-label="Connector governance views">
        <Button size="sm" variant={activeView === 'inventory' ? 'default' : 'outline'} role="tab" aria-selected={activeView === 'inventory'} onClick={() => setActiveView('inventory')}>Inventory</Button>
        <Button size="sm" variant={activeView === 'audit' ? 'default' : 'outline'} role="tab" aria-selected={activeView === 'audit'} onClick={() => setActiveView('audit')}>Audit history</Button>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {loading && <p className="mt-3 text-sm text-text-secondary">Loading governance data…</p>}

      {activeView === 'inventory' && !loading && !error && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="text-xs text-text-secondary">
              Search
              <input className="mt-1 w-full rounded-md border border-border-light bg-transparent px-2 py-1.5 text-sm dark:border-border-dark" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Name, provider, owner or ID" />
            </label>
            <label className="text-xs text-text-secondary">
              Connection state
              <select className="mt-1 w-full rounded-md border border-border-light bg-transparent px-2 py-1.5 text-sm dark:border-border-dark" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="all">All states</option>
                {['connected', 'degraded', 'disconnected', 'authorizing', 'error', 'revoked'].map((state) => <option key={state} value={state}>{state}</option>)}
              </select>
            </label>
          </div>
          <p className="mt-2 text-xs text-text-secondary">{filtered.length} of {installations.length} installations</p>
          <div className="mt-2 space-y-2">
            {filtered.map((item) => (
              <article key={item.id} className="rounded-lg border border-border-light p-3 text-sm dark:border-border-dark">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{item.displayName}</strong>
                  <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-xs">{item.state}</span>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                  <div><dt className="inline text-text-secondary">Provider: </dt><dd className="inline">{item.provider}</dd></div>
                  <div><dt className="inline text-text-secondary">Visibility: </dt><dd className="inline">{item.visibility}</dd></div>
                  <div><dt className="inline text-text-secondary">Owner ID: </dt><dd className="inline break-all">{item.ownerId}</dd></div>
                  <div><dt className="inline text-text-secondary">Shared with: </dt><dd className="inline">{item.grantedPrincipalCount} member(s)</dd></div>
                  <div><dt className="inline text-text-secondary">Last connected: </dt><dd className="inline">{formatDate(item.lastConnectedAt)}</dd></div>
                  <div><dt className="inline text-text-secondary">Updated: </dt><dd className="inline">{formatDate(item.updatedAt)}</dd></div>
                  <div><dt className="inline text-text-secondary">Last health check: </dt><dd className="inline">{formatDate(item.lastHealthCheckAt)}</dd></div>
                  <div><dt className="inline text-text-secondary">Last successful check: </dt><dd className="inline">{formatDate(item.lastSuccessfulHealthCheckAt)}</dd></div>
                  <div><dt className="inline text-text-secondary">Consecutive health failures: </dt><dd className="inline">{item.consecutiveHealthFailures}</dd></div>
                </dl>
                {item.lastErrorCode && <p className="mt-2 text-xs text-amber-600">Last error: {item.lastErrorCode}</p>}
              </article>
            ))}
            {filtered.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">No connector installations match these filters.</p>}
          </div>
        </>
      )}

      {activeView === 'audit' && !loading && !error && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-text-secondary">Showing {entries.length} recent entries{totalAudit ? ` of ${totalAudit}` : ''}. Sensitive request context and arbitrary metadata are not displayed.</p>
          {entries.map((entry) => (
            <article key={entry.id} className="rounded-lg border border-border-light p-3 text-sm dark:border-border-dark">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{entry.outcome === 'denied' ? 'Access denied' : 'Connector invoked'}</strong>
                <span className="text-xs text-text-secondary">{formatDate(entry.timestamp)}</span>
              </div>
              <p className="mt-1 text-xs">Actor: {entry.actor.name} · {entry.actor.type}</p>
              <p className="text-xs">Connector: {entry.metadata.provider ?? entry.target.name ?? 'Unknown provider'}</p>
              {entry.metadata.reason && <p className="mt-1 text-xs text-text-secondary">Reason: {entry.metadata.reason}</p>}
              <p className="mt-1 text-[11px] text-text-secondary">Audit sequence #{entry.integrity.seq}</p>
            </article>
          ))}
          {entries.length === 0 && <p className="py-4 text-center text-sm text-text-secondary">No connector invocation events found.</p>}
          {nextCursor != null && <div className="pt-2 text-center"><Button size="sm" variant="outline" disabled={loading} onClick={() => void loadAudit(nextCursor, true)}>Load older events</Button></div>}
        </div>
      )}
    </section>
  );
}
