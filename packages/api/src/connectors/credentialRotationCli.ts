import { rotateConnectorCredentialEncryption, type ConnectorCredentialRotationStore } from './ConnectorCredentialRotation';

export interface ConnectorCredentialRotationCliDeps {
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  runAsSystem: <T>(callback: () => Promise<T>) => Promise<T>;
  store: ConnectorCredentialRotationStore;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const usage =
  'Usage: rotate-connector-credentials [--dry-run] [--apply] [--batch-size=1..100] [--max-batches=1..100] [--after=<24-char-object-id>] [--after-revocations=<24-char-object-id>]. Dry-run is the default; --apply is required to persist changes. Configure CONNECTOR_CREDENTIALS_KEYRING and CONNECTOR_CREDENTIALS_ACTIVE_KEY_ID first.';

function readInteger(args: string[], name: string, fallback: number): number | undefined {
  const value = args.find((arg) => arg.startsWith(`--${name}=`));
  if (!value) return fallback;
  const raw = value.slice(name.length + 3);
  if (!/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function runConnectorCredentialRotationCli(
  args: string[],
  deps: ConnectorCredentialRotationCliDeps,
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    deps.write(usage);
    return 0;
  }
  const allowed = new Set(['--dry-run', '--apply']);
  const unknown = args.filter(
    (arg) => !allowed.has(arg) &&
      !/^--(?:batch-size|max-batches|after|after-revocations)=/.test(arg),
  );
  if (unknown.length || (args.includes('--dry-run') && args.includes('--apply'))) {
    deps.writeError(usage);
    return 2;
  }
  const batchSize = readInteger(args, 'batch-size', 50);
  const maxBatches = readInteger(args, 'max-batches', 10);
  const afterArg = args.find((arg) => arg.startsWith('--after='));
  const afterId = afterArg?.slice('--after='.length);
  const afterRevocationsArg = args.find((arg) => arg.startsWith('--after-revocations='));
  const afterRevocationId = afterRevocationsArg?.slice('--after-revocations='.length);
  if (
    batchSize === undefined ||
    batchSize < 1 ||
    batchSize > 100 ||
    maxBatches === undefined ||
    maxBatches < 1 ||
    maxBatches > 100 ||
    (afterId !== undefined && !/^[a-f\d]{24}$/i.test(afterId)) ||
    (afterRevocationId !== undefined && !/^[a-f\d]{24}$/i.test(afterRevocationId))
  ) {
    deps.writeError(usage);
    return 2;
  }

  let connected = false;
  try {
    await deps.connect();
    connected = true;
    const result = await deps.runAsSystem(() =>
      rotateConnectorCredentialEncryption({
        store: deps.store,
        batchSize,
        maxBatches,
        ...(afterId ? { afterId } : {}),
        ...(afterRevocationId ? { afterRevocationId } : {}),
        dryRun: !args.includes('--apply'),
      }),
    );
    deps.write(JSON.stringify(result));
    return result.failed > 0 || result.revocationFailed > 0 ? 1 : 0;
  } finally {
    if (connected) await deps.disconnect();
  }
}

export async function runConnectorCredentialRotationCommand(
  args: string[],
  deps: ConnectorCredentialRotationCliDeps,
): Promise<number> {
  try {
    return await runConnectorCredentialRotationCli(args, deps);
  } catch {
    deps.writeError('Connector credential rotation failed; check the operator configuration and protected logs.');
    return 1;
  }
}
