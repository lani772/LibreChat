export interface GoogleWorkspaceRevocationDeadLetterCliDeps {
  connect: () => Promise<unknown>;
  disconnect: () => Promise<unknown>;
  runAsSystem: <T>(callback: () => Promise<T>) => Promise<T>;
  store: {
    listGoogleWorkspaceRevocationDeadLetters(input: {
      afterId?: string;
      limit: number;
    }): Promise<Array<{
      id: string;
      installationId: string;
      attempts: number;
      lastErrorCode: string | null;
      updatedAt: Date;
    }>>;
    requeueGoogleWorkspaceRevocationDeadLetter(input: { id: string }): Promise<boolean>;
  };
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const usage =
  'Usage: manage-google-revocations list [--limit=1..100] [--after=<24-char-object-id>] | retry --id=<24-char-object-id>. Requires an operator-controlled environment and explicit system context. Never prints credentials or ciphertext.';

export async function runGoogleWorkspaceRevocationDeadLetterCli(
  args: string[],
  deps: GoogleWorkspaceRevocationDeadLetterCliDeps,
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    deps.write(usage);
    return 0;
  }
  const [command, ...flags] = args;
  const allowedFlags = command === 'list'
    ? new Set(['--limit', '--after'])
    : command === 'retry'
      ? new Set(['--id'])
      : new Set<string>();
  const parsed = new Map<string, string>();
  for (const flag of flags) {
    const match = /^(--[a-z-]+)=(.*)$/.exec(flag);
    if (!match || !allowedFlags.has(match[1]) || parsed.has(match[1])) {
      deps.writeError(usage);
      return 2;
    }
    parsed.set(match[1], match[2]);
  }

  let limit = 50;
  let afterId: string | undefined;
  let id: string | undefined;
  if (command === 'list') {
    const rawLimit = parsed.get('--limit');
    if (rawLimit !== undefined) {
      if (!/^\d+$/.test(rawLimit)) {
        deps.writeError(usage);
        return 2;
      }
      limit = Number(rawLimit);
    }
    afterId = parsed.get('--after');
    if (limit < 1 || limit > 100 ||
        (afterId !== undefined && !/^[a-f\d]{24}$/i.test(afterId))) {
      deps.writeError(usage);
      return 2;
    }
  } else if (command === 'retry') {
    id = parsed.get('--id');
    if (flags.length !== 1 || !id || !/^[a-f\d]{24}$/i.test(id)) {
      deps.writeError(usage);
      return 2;
    }
  } else {
    deps.writeError(usage);
    return 2;
  }

  let connected = false;
  try {
    await deps.connect();
    connected = true;
    const result = await deps.runAsSystem(async () => {
      if (command === 'list') {
        return deps.store.listGoogleWorkspaceRevocationDeadLetters({
          ...(afterId ? { afterId } : {}),
          limit,
        });
      }
      return {
        id,
        requeued: await deps.store.requeueGoogleWorkspaceRevocationDeadLetter({ id: id! }),
      };
    });
    deps.write(JSON.stringify(result));
    return 0;
  } finally {
    if (connected) await deps.disconnect();
  }
}

export async function runGoogleWorkspaceRevocationDeadLetterCommand(
  args: string[],
  deps: GoogleWorkspaceRevocationDeadLetterCliDeps,
): Promise<number> {
  try {
    return await runGoogleWorkspaceRevocationDeadLetterCli(args, deps);
  } catch {
    deps.writeError('Google Workspace revocation operation failed; check protected operator logs.');
    return 1;
  }
}
