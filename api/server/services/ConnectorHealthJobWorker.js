const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { logger, tenantStorage, getTenantId, getUserId, runAsSystem } = require('@librechat/data-schemas');
const { ConnectorHealthRetryPolicy } = require('@librechat/api');

const POLL_INTERVAL_MS = 10_000;
const LEASE_MS = 60_000;
const SUCCESS_INTERVAL_MS = 24 * 60 * 60_000;
const COLLECTION = 'connectorhealthjobs';

const schema = new mongoose.Schema({
  tenantId: { type: String, required: true },
  ownerUserId: { type: String, required: true },
  installationId: { type: String, required: true, match: /^[a-f\\d]{24}$/i },
  provider: { type: String, required: true, enum: ['google-workspace'] },
  status: { type: String, required: true, enum: ['pending', 'processing', 'completed', 'dead'] },
  attempt: { type: Number, required: true, default: 0, min: 0, max: 10 },
  nextAttemptAt: { type: Date, required: true },
  leaseToken: { type: String },
  leaseUntil: { type: Date },
  fence: { type: Number, required: true, default: 0 },
  activeKey: { type: String },
  lastErrorCode: { type: String, maxlength: 80 },
}, { timestamps: true, strict: 'throw', collection: COLLECTION });
schema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
const HealthJob = mongoose.models.ConnectorHealthJob || mongoose.model('ConnectorHealthJob', schema);

const retryPolicy = new ConnectorHealthRetryPolicy();
let timer;
let stopped = true;
let running = false;

function trustedActiveKey(tenantId, ownerUserId, installationId) {
  return [tenantId, ownerUserId, installationId].join(':');
}

/** Enqueue only from an authenticated owner context; no identity is accepted from request data. */
async function enqueueOwnerHealthCheck({ installationId, provider = 'google-workspace', delayMs = 0 }) {
  const tenantId = getTenantId();
  const ownerUserId = getUserId();
  if (!tenantId || !ownerUserId || tenantId === '__SYSTEM__') {
    throw new Error('Health jobs require an authenticated tenant owner context');
  }
  if (!/^[a-f\\d]{24}$/i.test(installationId) || provider !== 'google-workspace') {
    throw new Error('Invalid connector health job target');
  }
  const activeKey = trustedActiveKey(tenantId, ownerUserId, installationId);
  const now = new Date();
  try {
    return await HealthJob.findOneAndUpdate(
      { activeKey },
      { $setOnInsert: {
        tenantId, ownerUserId, installationId, provider, status: 'pending',
        attempt: 0, nextAttemptAt: new Date(now.getTime() + Math.max(0, delayMs)),
        fence: 0, activeKey,
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean().exec();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return HealthJob.findOne({ activeKey }).lean().exec();
  }
}

async function claimJob() {
  const now = new Date();
  const token = randomUUID();
  return HealthJob.findOneAndUpdate(
    {
      nextAttemptAt: { $lte: now },
      $or: [
        { status: 'pending' },
        { status: 'processing', leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: { status: 'processing', leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { fence: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } },
  ).lean().exec();
}

async function updateClaim(job, update) {
  const result = await HealthJob.updateOne(
    { _id: job._id, status: 'processing', leaseToken: job.leaseToken, fence: job.fence },
    update,
  ).exec();
  return result.modifiedCount === 1;
}

async function processClaim(job, monitor, db) {
  const identity = { tenantId: job.tenantId, userId: job.ownerUserId };
  return tenantStorage.run(identity, async () => {
    const installation = await db.getConnectorInstallation(job.installationId);
    if (!installation ||
        installation.tenantId !== job.tenantId ||
        installation.ownerUserId !== job.ownerUserId ||
        installation.provider !== job.provider ||
        !['connected', 'degraded'].includes(installation.state)) {
      await updateClaim(job, {
        $set: { status: 'completed', lastErrorCode: 'installation_not_eligible' },
        $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
      });
      return;
    }

    const result = await monitor.checkInstallation(job.installationId);
    if (result.status === 'healthy') {
      await updateClaim(job, {
        $set: {
          status: 'pending',
          attempt: 0,
          nextAttemptAt: new Date(Date.now() + SUCCESS_INTERVAL_MS),
          lastErrorCode: null,
        },
        $unset: { leaseToken: 1, leaseUntil: 1 },
      });
      return;
    }
    if (result.status !== 'unhealthy') {
      await updateClaim(job, {
        $set: { status: 'completed', lastErrorCode: 'health_check_not_actionable' },
        $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
      });
      return;
    }

    const nextAttempt = job.attempt + 1;
    const decision = retryPolicy.decide({
      errorCode: result.errorCode || 'PROVIDER_UNAVAILABLE',
      attempt: nextAttempt,
    });
    if (!decision.retry) {
      await updateClaim(job, {
        $set: { status: 'dead', attempt: nextAttempt, lastErrorCode: decision.errorCode },
        $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
      });
      return;
    }
    await updateClaim(job, {
      $set: {
        status: 'pending',
        attempt: nextAttempt,
        nextAttemptAt: decision.nextAttemptAt,
        lastErrorCode: decision.errorCode,
      },
      $unset: { leaseToken: 1, leaseUntil: 1 },
    });
  });
}

/** Starts a durable worker; claims are global, probes always re-enter the persisted owner context. */
function startConnectorHealthJobWorker({ monitor, db: database }) {
  if (timer) return () => stopConnectorHealthJobWorker();
  stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (let count = 0; count < 10; count++) {
        const job = await runAsSystem(async () => claimJob());
        if (!job) break;
        try {
          await processClaim(job, monitor, database);
        } catch {
          const nextAttempt = job.attempt + 1;
          const decision = retryPolicy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: nextAttempt });
          await runAsSystem(async () => updateClaim(job, decision.retry ? {
            $set: { status: 'pending', attempt: nextAttempt, nextAttemptAt: decision.nextAttemptAt, lastErrorCode: decision.errorCode },
            $unset: { leaseToken: 1, leaseUntil: 1 },
          } : {
            $set: { status: 'dead', attempt: nextAttempt, lastErrorCode: decision.errorCode },
            $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
          })).catch(() => false);
        }
      }
    } catch {
      logger.error('[Connectors] Health job worker iteration failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return () => stopConnectorHealthJobWorker();
}

function stopConnectorHealthJobWorker() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = undefined;
}

module.exports = {
  enqueueOwnerHealthCheck,
  startConnectorHealthJobWorker,
  stopConnectorHealthJobWorker,
};
