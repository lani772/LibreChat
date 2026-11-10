import {
  runGoogleWorkspaceRevocationDeadLetterCli,
  runGoogleWorkspaceRevocationDeadLetterCommand,
} from './revocationDeadLetterCli';

describe('Google Workspace revocation dead-letter CLI', () => {
  function harness() {
    const output: string[] = [];
    const errors: string[] = [];
    const deps = {
      connect: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
      runAsSystem: jest.fn(async <T>(callback: () => Promise<T>) => callback()),
      store: {
        listGoogleWorkspaceRevocationDeadLetters: jest.fn(async () => [{
          id: '64b000000000000000000001',
          installationId: '64b000000000000000000002',
          attempts: 12,
          lastErrorCode: 'google_revocation_failed',
          updatedAt: new Date('2026-11-10T00:00:00.000Z'),
        }]),
        requeueGoogleWorkspaceRevocationDeadLetter: jest.fn(async () => true),
      },
      write: (message: string) => output.push(message),
      writeError: (message: string) => errors.push(message),
    };
    return { deps, output, errors };
  }

  it('lists safe dead-letter metadata inside system context', async () => {
    const h = harness();
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['list', '--limit=20'], h.deps)).toBe(0);
    expect(h.deps.runAsSystem).toHaveBeenCalledTimes(1);
    expect(h.deps.store.listGoogleWorkspaceRevocationDeadLetters).toHaveBeenCalledWith({ limit: 20 });
    expect(h.output[0]).toContain('google_revocation_failed');
    expect(h.output[0]).not.toContain('encryptedPayload');
    expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
  });

  it('requeues only a validated dead-letter ID', async () => {
    const h = harness();
    const id = '64b000000000000000000001';
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['retry', `--id=${id}`], h.deps)).toBe(0);
    expect(h.deps.store.requeueGoogleWorkspaceRevocationDeadLetter).toHaveBeenCalledWith({ id });
    expect(JSON.parse(h.output[0])).toEqual({ id, requeued: true });
  });

  it('rejects unknown commands, malformed IDs, and duplicate flags before connecting', async () => {
    const h = harness();
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['purge'], h.deps)).toBe(2);
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['retry', '--id=bad'], h.deps)).toBe(2);
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['list', '--limit=500'], h.deps)).toBe(2);
    expect(await runGoogleWorkspaceRevocationDeadLetterCli(['list', '--limit=2', '--limit=3'], h.deps)).toBe(2);
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(4);
  });

  it('returns a safe failure and disconnects when the store fails', async () => {
    const h = harness();
    h.deps.store.listGoogleWorkspaceRevocationDeadLetters.mockRejectedValue(new Error('secret detail'));
    expect(await runGoogleWorkspaceRevocationDeadLetterCommand(['list'], h.deps)).toBe(1);
    expect(h.errors[0]).not.toContain('secret detail');
    expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
  });
});
