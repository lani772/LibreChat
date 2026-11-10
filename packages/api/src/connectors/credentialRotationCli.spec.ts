import {
  runConnectorCredentialRotationCli,
  runConnectorCredentialRotationCommand,
} from './credentialRotationCli';

describe('connector credential rotation CLI', () => {
  function harness() {
    const output: string[] = [];
    const errors: string[] = [];
    const deps = {
      connect: jest.fn(async () => undefined),
      disconnect: jest.fn(async () => undefined),
      runAsSystem: jest.fn(async <T>(callback: () => Promise<T>) => callback()),
      store: {
        listConnectorCredentialsForRotation: jest.fn(async () => []),
        replaceConnectorCredentialForRotation: jest.fn(async () => true),
      },
      write: (message: string) => output.push(message),
      writeError: (message: string) => errors.push(message),
    };
    return { deps, output, errors };
  }

  it('defaults to dry-run and executes the scan inside system context', async () => {
    const h = harness();
    expect(await runConnectorCredentialRotationCli([], h.deps)).toBe(0);
    expect(h.deps.connect).toHaveBeenCalledTimes(1);
    expect(h.deps.runAsSystem).toHaveBeenCalledTimes(1);
    expect(h.deps.store.listConnectorCredentialsForRotation).toHaveBeenCalledWith({ limit: 50 });
    expect(JSON.parse(h.output[0])).toMatchObject({ dryRun: true, complete: true });
    expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
  });

  it('requires explicit --apply to write and accepts a resume cursor', async () => {
    const h = harness();
    const cursor = '64b000000000000000000001';
    expect(
      await runConnectorCredentialRotationCli(
        ['--apply', '--batch-size=25', '--max-batches=2', `--after=${cursor}`],
        h.deps,
      ),
    ).toBe(0);
    expect(h.deps.store.listConnectorCredentialsForRotation).toHaveBeenCalledWith({
      afterId: cursor,
      limit: 25,
    });
    expect(JSON.parse(h.output[0]).dryRun).toBe(false);
  });

  it('rejects invalid or conflicting flags before connecting', async () => {
    const h = harness();
    expect(await runConnectorCredentialRotationCli(['--apply', '--dry-run'], h.deps)).toBe(2);
    expect(await runConnectorCredentialRotationCli(['--batch-size=1000'], h.deps)).toBe(2);
    expect(await runConnectorCredentialRotationCli(['--after=bad'], h.deps)).toBe(2);
    expect(h.deps.connect).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(3);
  });

  it('returns failure status for undecryptable rows and always disconnects', async () => {
    const h = harness();
    h.deps.store.listConnectorCredentialsForRotation.mockRejectedValueOnce(new Error('db detail'));
    expect(await runConnectorCredentialRotationCommand(['--apply'], h.deps)).toBe(1);
    expect(h.errors).toEqual([
      'Connector credential rotation failed; check the operator configuration and protected logs.',
    ]);
    expect(h.deps.disconnect).toHaveBeenCalledTimes(1);
  });

  it('prints help without connecting', async () => {
    const h = harness();
    expect(await runConnectorCredentialRotationCli(['--help'], h.deps)).toBe(0);
    expect(h.output[0]).toContain('--apply');
    expect(h.deps.connect).not.toHaveBeenCalled();
  });
});
