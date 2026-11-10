const { logger, runAsSystem } = require('@librechat/data-schemas');
const { processGoogleWorkspaceRevocationBatch } = require('@librechat/api');
const db = require('~/models');

const POLL_INTERVAL_MS = 15_000;
let timer;
let running = false;
let stopped = true;

/** Starts a bounded worker; Mongo leases coordinate replicas and prevent duplicate sends. */
function startGoogleWorkspaceRevocationWorker(adapter) {
  if (timer) return () => stopGoogleWorkspaceRevocationWorker();
  stopped = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await runAsSystem(async () =>
        processGoogleWorkspaceRevocationBatch({
          adapter,
          store: {
            claimGoogleWorkspaceRevocation: (input) => db.claimGoogleWorkspaceRevocation(input),
            isConnectorInstallationRevokedForSystem: (input) =>
              db.isConnectorInstallationRevokedForSystem(input),
            completeGoogleWorkspaceRevocation: (input) =>
              db.completeGoogleWorkspaceRevocation(input),
            retryGoogleWorkspaceRevocation: (input) =>
              db.retryGoogleWorkspaceRevocation(input),
          },
          batchSize: 10,
          leaseMs: 60_000,
          maxAttempts: 12,
        }),
      );
      if (result.claimed > 0) {
        logger.info(
          `[Connectors][Google] Revocation batch: ${result.claimed} claimed, ${result.completed} completed, ${result.rescheduled} rescheduled, ${result.dead} dead, ${result.leaseLost} lease-lost`,
        );
      }
    } catch {
      logger.error('[Connectors][Google] Revocation worker iteration failed');
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return () => stopGoogleWorkspaceRevocationWorker();
}

function stopGoogleWorkspaceRevocationWorker() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}

module.exports = { startGoogleWorkspaceRevocationWorker, stopGoogleWorkspaceRevocationWorker };
