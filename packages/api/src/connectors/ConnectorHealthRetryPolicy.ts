export type ConnectorHealthFailureClass = 'transient' | 'reauthorization_required' | 'access_denied' | 'permanent';

export type ConnectorHealthRetryDecision = {
  retry: boolean;
  failureClass: ConnectorHealthFailureClass;
  errorCode: string;
  nextAttemptAt: Date | null;
};

/**
 * Pure retry policy for an owner-scoped health job runner.
 *
 * This policy deliberately does not enqueue work or select connector records.
 * The caller must persist the job with its trusted tenant/principal identity and
 * re-enter that context before invoking ConnectorHealthMonitor.
 */
export class ConnectorHealthRetryPolicy {
  constructor(
    private readonly options: {
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      random?: () => number;
    } = {},
  ) {
    const maxAttempts = options.maxAttempts ?? 5;
    const baseDelayMs = options.baseDelayMs ?? 30_000;
    const maxDelayMs = options.maxDelayMs ?? 30 * 60_000;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new Error('Connector health max attempts must be between 1 and 10');
    }
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 1 || baseDelayMs > 60 * 60_000) {
      throw new Error('Connector health base delay is invalid');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 24 * 60 * 60_000) {
      throw new Error('Connector health max delay is invalid');
    }
  }

  decide(input: {
    errorCode: string;
    attempt: number;
    now?: Date;
  }): ConnectorHealthRetryDecision {
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error('Connector health attempt must be a positive integer');
    }

    const terminal: Record<string, { failureClass: ConnectorHealthFailureClass; errorCode: string }> = {
      invalid_grant: { failureClass: 'reauthorization_required', errorCode: 'google_reauthorization_required' },
      google_reauthorization_required: { failureClass: 'reauthorization_required', errorCode: 'google_reauthorization_required' },
      CONNECTOR_ACCESS_DENIED: { failureClass: 'access_denied', errorCode: 'connector_access_denied' },
      INSUFFICIENT_SCOPE: { failureClass: 'permanent', errorCode: 'provider_insufficient_scope' },
    };
    const terminalDecision = terminal[input.errorCode];
    if (terminalDecision) {
      return { retry: false, ...terminalDecision, nextAttemptAt: null };
    }

    const maxAttempts = this.options.maxAttempts ?? 5;
    if (input.attempt >= maxAttempts) {
      return {
        retry: false,
        failureClass: 'transient',
        errorCode: 'connector_health_retry_exhausted',
        nextAttemptAt: null,
      };
    }

    const base = this.options.baseDelayMs ?? 30_000;
    const cap = this.options.maxDelayMs ?? 30 * 60_000;
    const exponential = Math.min(cap, base * (2 ** (input.attempt - 1)));
    const random = this.options.random ?? Math.random;
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample > 1) {
      throw new Error('Connector health retry random source must return a value from 0 to 1');
    }
    // Equal jitter avoids synchronized retry waves while keeping a useful delay.
    const delay = Math.floor(exponential / 2 + sample * (exponential / 2));
    return {
      retry: true,
      failureClass: 'transient',
      errorCode: 'provider_unavailable',
      nextAttemptAt: new Date((input.now ?? new Date()).getTime() + delay),
    };
  }
}
