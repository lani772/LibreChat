export interface ConnectorHealthRecord {
  _id: { toString(): string };
  provider: string;
  state: 'disconnected' | 'authorizing' | 'connected' | 'degraded' | 'revoked' | 'error';
  version: number;
  healthVersion: number;
  consecutiveHealthFailures?: number;
  lastErrorCode?: string;
}

export interface ConnectorHealthStore {
  getConnectorInstallation(id: string): Promise<ConnectorHealthRecord | null>;
  listConnectorInstallations(options: {
    state?: 'connected' | 'degraded';
    limit: number;
  }): Promise<ConnectorHealthRecord[]>;
  recordConnectorHealth(input: {
    installationId: string;
    expectedHealthVersion: number;
    outcome: 'healthy' | 'unhealthy';
    errorCode?: string;
    failureThreshold: number;
    checkedAt: Date;
  }): Promise<ConnectorHealthRecord | null>;
}

export type ConnectorHealthResult = {
  installationId: string;
  status: 'healthy' | 'unhealthy' | 'skipped' | 'stale';
  state: ConnectorHealthRecord['state'];
  consecutiveFailures: number;
  errorCode: string | null;
};

export type ConnectorHealthProbe = (installationId: string) => Promise<void>;

function safeHealthError(error: unknown, _provider: string): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'INSUFFICIENT_SCOPE') return 'provider_insufficient_scope';
  if (code === 'PROVIDER_UNAVAILABLE') return 'provider_unavailable';
  if (code === 'INVALID_RESPONSE') return 'provider_invalid_response';
  return 'connector_health_check_failed';
}

/**
 * Runs bounded provider probes and persists health observations using the
 * tenant-scoped connector store. Scheduling is intentionally external: callers
 * must execute this service inside a trusted tenant/principal context.
 */
export class ConnectorHealthMonitor {
  constructor(
    private readonly store: ConnectorHealthStore,
    private readonly probes: Record<string, ConnectorHealthProbe>,
    private readonly options: {
      failureThreshold?: number;
      now?: () => Date;
    } = {},
  ) {
    const threshold = options.failureThreshold ?? 3;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10) {
      throw new Error('Connector health failure threshold must be between 1 and 10');
    }
  }

  async checkInstallation(installationId: string): Promise<ConnectorHealthResult> {
    const installation = await this.store.getConnectorInstallation(installationId);
    if (!installation) {
      return {
        installationId, status: 'skipped', state: 'disconnected',
        consecutiveFailures: 0, errorCode: null,
      };
    }
    if (installation.state !== 'connected' && installation.state !== 'degraded') {
      return {
        installationId, status: 'skipped', state: installation.state,
        consecutiveFailures: installation.consecutiveHealthFailures ?? 0,
        errorCode: installation.lastErrorCode ?? null,
      };
    }

    const probe = this.probes[installation.provider];
    if (!probe) {
      return {
        installationId, status: 'skipped', state: installation.state,
        consecutiveFailures: installation.consecutiveHealthFailures ?? 0,
        errorCode: 'health_probe_not_configured',
      };
    }

    let outcome: 'healthy' | 'unhealthy' = 'healthy';
    let errorCode: string | undefined;
    try {
      await probe(installationId);
    } catch (error) {
      outcome = 'unhealthy';
      errorCode = safeHealthError(error, installation.provider);
    }

    const updated = await this.store.recordConnectorHealth({
      installationId,
      expectedHealthVersion: installation.healthVersion,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      failureThreshold: this.options.failureThreshold ?? 3,
      checkedAt: this.options.now?.() ?? new Date(),
    });
    if (!updated) {
      return {
        installationId, status: 'stale', state: installation.state,
        consecutiveFailures: installation.consecutiveHealthFailures ?? 0,
        errorCode: null,
      };
    }
    return {
      installationId,
      status: outcome,
      state: updated.state,
      consecutiveFailures: updated.consecutiveHealthFailures ?? 0,
      errorCode: updated.lastErrorCode ?? null,
    };
  }

  async checkBatch(limit = 20): Promise<{
    checked: number;
    healthy: number;
    unhealthy: number;
    skipped: number;
    stale: number;
    results: ConnectorHealthResult[];
  }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error('Connector health batch size must be between 1 and 25');
    }
    const connected = await this.store.listConnectorInstallations({
      limit,
      state: 'connected',
    });
    const degraded = await this.store.listConnectorInstallations({
      limit,
      state: 'degraded',
    });
    // Interleave states so a large connected population cannot starve degraded recovery.
    const candidates: ConnectorHealthRecord[] = [];
    for (let index = 0; candidates.length < limit && (index < connected.length || index < degraded.length); index += 1) {
      if (index < degraded.length) candidates.push(degraded[index]);
      if (candidates.length < limit && index < connected.length) candidates.push(connected[index]);
    }
    const results: ConnectorHealthResult[] = [];
    for (const installation of candidates) {
      results.push(await this.checkInstallation(installation._id.toString()));
    }
    return {
      checked: results.length,
      healthy: results.filter((item) => item.status === 'healthy').length,
      unhealthy: results.filter((item) => item.status === 'unhealthy').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      stale: results.filter((item) => item.status === 'stale').length,
      results,
    };
  }
}
