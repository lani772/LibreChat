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
  installationId: { type: String, required: true, match: /^[a-f\d]{24}$/i },
  provider: { type: String, required: true, enum: ['google-workspace'] },
  status: { type: String, required: true, enum: ['pending', 'processing', 'completed', 'dead'] },
  attempt: { type: Number, required: true, default: 0, min: 0, max: 10 },
  nextAttemptAt: { type: Date, required: true },
  leaseToken: { type: String },
  leaseUntil: { type: Date },
  fence: { type: Number, required: true, default: 0 },
  activeKey: { type: String },
  lastErrorCode: { type: String, maxlength: 80 },
  auditOutbox: [{
    eventId: { type: String, required: true },
    action: { type: String, required: true },
    outcome: { type: String, required: true },
    severity: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  }],
}, { timestamps: true, strict: 'throw', collection: COLLECTION });
schema.index({ activeKey: 1 }, { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } });
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
const HealthJob = mongoose.models.ConnectorHealthJob || mongoose.model('ConnectorHealthJob', schema);

const retryPolicy = new ConnectorHealthRetryPolicy();
let timer;
let stopped = true;
let running = false;
const indexesReady = HealthJob.createIndexes();

function healthJobAuditEvent(action, outcome, severity, metadata) {
  return {
    eventId: randomUUID(),
    action,
    outcome,
    severity,
    metadata,
    createdAt: new Date(),
  };
}

/**
 * The job document is the durable outbox. Append the event in the same atomic
 * state transition, then deliver it to the existing hash-chained tenant audit
 * log. Delivery is at-least-once across a crash between append and outbox ack.
 */
async function flushHealthJobAuditOutbox(jobId, auditDb) {
  /** Drain the durable outbox in order; failed writes leave the head event intact. */
  for (;;) {
    const pending = await HealthJob.findOne({ _id: jobId, 'auditOutbox.0': { $exists: true } })
      .select('tenantId installationId provider auditOutbox')
      .lean()
      .exec();
    if (!pending) return;
    const event = pending.auditOutbox[0];
    await auditDb.recordAuditEntry({
      action: event.action,
      outcome: event.outcome,
      severity: event.severity,
      actor: { type: 'service', name: 'connector-health-worker' },
      target: { type: 'connector', id: pending.installationId, name: 'Google Workspace' },
      tenantId: pending.tenantId,
      metadata: {
        ...event.metadata,
        provider: pending.provider,
        eventId: event.eventId,
        jobId: pending._id.toString(),
      },
    }, { failClosed: true });
    await HealthJob.updateOne(
      { _id: jobId, 'auditOutbox.eventId': event.eventId },
      { $pull: { auditOutbox: { eventId: event.eventId } } },
    ).exec();
  }
}

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
  if (!/^[a-f\d]{24}$/i.test(installationId) || provider !== 'google-workspace') {
    throw new Error('Invalid connector health job target');
  }
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 7 * 24 * 60 * 60_000) {
    throw new Error('Connector health job delay is invalid');
  }
  await indexesReady;
  const activeKey = trustedActiveKey(tenantId, ownerUserId, installationId);
  const now = new Date();
  try {
    const job = await HealthJob.findOneAndUpdate(
      { activeKey },
      { $setOnInsert: {
        tenantId, ownerUserId, installationId, provider, status: 'pending',
        attempt: 0, nextAttemptAt: new Date(now.getTime() + Math.max(0, delayMs)),
        fence: 0, activeKey,
        auditOutbox: [healthJobAuditEvent('connector.health_job_scheduled', 'pending', 'info', { delayMs })],
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean().exec();
    await flushHealthJobAuditOutbox(job._id, require('~/models'));
    return job;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return HealthJob.findOne({ activeKey }).lean().exec();
  }
}

/** Returns a safe, bounded operational projection for the authenticated owner. */
async function listOwnerHealthJobs({ installationId, limit = 10 }) {
  const tenantId = getTenantId();
  const ownerUserId = getUserId();
  if (!tenantId || !ownerUserId || tenantId === '__SYSTEM__') {
    throw new Error('Health job visibility requires an authenticated tenant owner context');
  }
  if (!/^[a-f\d]{24}$/i.test(installationId) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new Error('Invalid connector health job query');
  }
  await indexesReady;
  const jobs = await HealthJob.find({ tenantId, ownerUserId, installationId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('status attempt nextAttemptAt lastErrorCode createdAt updatedAt')
    .lean()
    .exec();
  return jobs.map((job) => ({
    id: job._id.toString(),
    status: job.status,
    attempt: job.attempt,
    nextAttemptAt: job.nextAttemptAt,
    lastErrorCode: job.lastErrorCode || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }));
}

/** Owner-authorized replay of a dead job; identity is read only from trusted context. */
async function retryOwnerDeadHealthJob({ installationId, jobId }) {
  const tenantId = getTenantId();
  const ownerUserId = getUserId();
  if (!tenantId || !ownerUserId || tenantId === '__SYSTEM__') {
    throw new Error('Health job recovery requires an authenticated tenant owner context');
  }
  if (!/^[a-f\\d]{24}$/i.test(installationId) || !/^[a-f\\d]{24}$/i.test(jobId)) {
    throw new Error('Invalid connector health job recovery target');
  }
  await indexesReady;
  const activeKey = trustedActiveKey(tenantId, ownerUserId, installationId);
  const event = healthJobAuditEvent(
    'connector.health_job_scheduled',
    'pending',
    'warning',
    { source: 'owner_dead_job_recovery' },
  );
  let job;
  try {
    job = await HealthJob.findOneAndUpdate(
      { _id: jobId, tenantId, ownerUserId, installationId, status: 'dead', provider: 'google-workspace' },
      {
        $set: { status: 'pending', attempt: 0, nextAttemptAt: new Date(), activeKey, lastErrorCode: null },
        $unset: { leaseToken: 1, leaseUntil: 1 },
        $push: { auditOutbox: event },
      },
      { new: true },
    ).lean().exec();
  } catch (error) {
    if (error?.code === 11000) throw new Error('An active health job already exists for this connector');
    throw error;
  }
  if (!job) return null;
  await flushHealthJobAuditOutbox(job._id, require('~/models')).catch(() => undefined);
  return { id: job._id.toString(), status: job.status, nextAttemptAt: job.nextAttemptAt };
}

async function claimJob() {
  const now = new Date();
  const token = randomUUID();
  // Recover an expired lease atomically and append its audit event in the same
  // Mongo update. The prior fence is captured before incrementing it.
  const leaseEvent = healthJobAuditEvent(
    'connector.health_job_lease_recovered',
    'pending',
    'warning',
    { recoveredAt: now.toISOString(), recovery: 'expired_lease' },
  );
  const expired = await HealthJob.findOneAndUpdate(
    { status: 'processing', leaseUntil: { $lte: now } },
    [{
      $set: {
        status: 'processing',
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        fence: { $add: ['$fence', 1] },
        auditOutbox: {
          $concatArrays: [
            { $ifNull: ['$auditOutbox', []] },
            [{ ...leaseEvent, metadata: { ...leaseEvent.metadata, previousFence: { $toString: '$fence' } } }],
          ],
        },
      },
    }],
    { new: true, sort: { leaseUntil: 1, createdAt: 1 } },
  ).lean().exec();
  if (expired) return expired;

  return HealthJob.findOneAndUpdate(
    { status: 'pending', nextAttemptAt: { $lte: now } },
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
        $push: { auditOutbox: healthJobAuditEvent('connector.health_job_dead_lettered', 'failure', 'critical', { attempt: nextAttempt, errorCode: decision.errorCode, fence: job.fence }) },
        $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
      });
      await flushHealthJobAuditOutbox(job._id, db);
      return;
    }
    await updateClaim(job, {
      $set: {
        status: 'pending',
        attempt: nextAttempt,
        nextAttemptAt: decision.nextAttemptAt,
        lastErrorCode: decision.errorCode,
      },
      $push: { auditOutbox: healthJobAuditEvent('connector.health_job_retry_scheduled', 'pending', 'warning', { attempt: nextAttempt, errorCode: decision.errorCode, nextAttemptAt: decision.nextAttemptAt.toISOString(), fence: job.fence }) },
      $unset: { leaseToken: 1, leaseUntil: 1 },
    });
    await flushHealthJobAuditOutbox(job._id, db);
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
      await indexesReady;
      // Recover audit delivery after process restarts even when no job is currently due.
      const outboxJobs = await HealthJob.find({ 'auditOutbox.0': { $exists: true } }).select('_id').limit(25).lean().exec();
      for (const pending of outboxJobs) {
        await flushHealthJobAuditOutbox(pending._id, database).catch(() => undefined);
      }
      for (let count = 0; count < 10; count++) {
        const job = await runAsSystem(async () => claimJob());
        if (!job) break;
        try {
          await flushHealthJobAuditOutbox(job._id, database).catch(() => undefined);
          await processClaim(job, monitor, database);
        } catch {
          const nextAttempt = job.attempt + 1;
          const decision = retryPolicy.decide({ errorCode: 'PROVIDER_UNAVAILABLE', attempt: nextAttempt });
          await runAsSystem(async () => updateClaim(job, decision.retry ? {
            $set: { status: 'pending', attempt: nextAttempt, nextAttemptAt: decision.nextAttemptAt, lastErrorCode: decision.errorCode },
            $unset: { leaseToken: 1, leaseUntil: 1 },
          } : {
            $set: { status: 'dead', attempt: nextAttempt, lastErrorCode: decision.errorCode },
            $push: { auditOutbox: healthJobAuditEvent('connector.health_job_dead_lettered', 'failure', 'critical', { attempt: nextAttempt, errorCode: decision.errorCode, fence: job.fence }) },
            $unset: { activeKey: 1, leaseToken: 1, leaseUntil: 1 },
          })).catch(() => false);
          await flushHealthJobAuditOutbox(job._id, database).catch(() => undefined);
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
  listOwnerHealthJobs,
  retryOwnerDeadHealthJob,
  startConnectorHealthJobWorker,
  stopConnectorHealthJobWorker,
};
