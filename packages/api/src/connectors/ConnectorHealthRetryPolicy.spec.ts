import { ConnectorHealthRetryPolicy } from './ConnectorHealthRetryPolicy';

describe('ConnectorHealthRetryPolicy', () => {
  const now = new Date('2026-11-10T04:00:00.000Z');

  it('uses bounded exponential backoff with jitter', () => {
    const policy = new ConnectorHealthRetryPolicy({
      baseDelayMs: 1_000, maxDelayMs: 5_000, random: () => 1,
    });
    expect(policy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: 1, now }).nextAttemptAt)
      .toEqual(new Date(now.getTime() + 1_000));
    expect(policy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: 3, now }).nextAttemptAt)
      .toEqual(new Date(now.getTime() + 4_000));
    expect(policy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: 5, now }).nextAttemptAt)
      .toEqual(new Date(now.getTime() + 5_000));
  });

  it('does not retry invalid grants, access denial, or insufficient scope', () => {
    const policy = new ConnectorHealthRetryPolicy();
    expect(policy.decide({ errorCode: 'invalid_grant', attempt: 1, now })).toMatchObject({
      retry: false, failureClass: 'reauthorization_required',
      errorCode: 'google_reauthorization_required', nextAttemptAt: null,
    });
    expect(policy.decide({ errorCode: 'CONNECTOR_ACCESS_DENIED', attempt: 1, now }))
      .toMatchObject({ retry: false, failureClass: 'access_denied' });
    expect(policy.decide({ errorCode: 'INSUFFICIENT_SCOPE', attempt: 1, now }))
      .toMatchObject({ retry: false, failureClass: 'permanent' });
  });

  it('stops after the configured attempt limit', () => {
    const policy = new ConnectorHealthRetryPolicy({ maxAttempts: 2 });
    expect(policy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: 2, now }))
      .toMatchObject({ retry: false, errorCode: 'connector_health_retry_exhausted' });
  });

  it('validates attempt and jitter source', () => {
    const policy = new ConnectorHealthRetryPolicy({ random: () => 2 });
    expect(() => policy.decide({ errorCode: 'x', attempt: 0, now })).toThrow();
    expect(() => policy.decide({ errorCode: 'x', attempt: 1, now })).toThrow();
  });
});
