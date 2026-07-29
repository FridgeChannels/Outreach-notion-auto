import {
  acquireLock,
  clearExpiredRetryCooldowns,
  isRetryCoolingDown,
  releaseLock,
} from "../locks.js";
import {
  claimSession,
  countSessionsByStatus,
  fetchDueSessions,
  guardPlanDrift,
  loadSession,
  reclaimStuckSessions,
  type DueSessionRow,
} from "../notion/sessionRepository.js";
import { isSchedulerEligible } from "./validators.js";
import { fetchDueMailboxes } from "../notion/mailboxRepository.js";
import { closeBrowserContext, openBrowserContext } from "../browser.js";
import { OutreachBatchChat } from "./chatReuse.js";
import { processOutreachJob, type OutreachJob } from "./processOutreach.js";
import { processMailboxJob, type MailboxJob } from "./processMailbox.js";
import { logger } from "../logging.js";
import { startTracing, stopTracing } from "../artifacts.js";
import { OUTREACH_BATCH_LIMIT, WORKER_ID } from "../config.js";

/**
 * Start each worker at a different index of the shared due list.
 *
 * All workers query the same "Next Wake At ascending" page, so without an offset
 * they march through identical rows and pile up on the same locks.
 */
export function rotateForWorker(
  rows: DueSessionRow[],
  workerId = WORKER_ID,
): DueSessionRow[] {
  if (rows.length < 2) return [...rows];
  let hash = 0;
  for (const ch of workerId) hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  const offset = hash % rows.length;
  return [...rows.slice(offset), ...rows.slice(0, offset)];
}

/**
 * Lazy claim: lock + claim one Session at a time inside the batch loop.
 * Avoids pre-claiming the whole due set (which left Claimed orphans when
 * waiting locks expired mid-batch).
 */
export async function pollAndProcessOutreach(
  limit = OUTREACH_BATCH_LIMIT,
): Promise<void> {
  await clearExpiredRetryCooldowns().catch(() => 0);
  const reclaim = await reclaimStuckSessions();
  if (reclaim.reclaimed || reclaim.reconciled) {
    logger.info("Reclaimed stuck sessions", {
      reclaimed: reclaim.reclaimed,
      reconciled: reclaim.reconciled,
      detailCount: reclaim.details.length,
    });
  }

  const due = await fetchDueSessions(limit);
  if (!due.length) {
    const byStatus = await countSessionsByStatus().catch(() => ({}));
    logger.info("No due outreach sessions", {
      sessions_by_status: byStatus,
      reclaimed: reclaim.reclaimed,
      reconciled: reclaim.reconciled,
    });
    return;
  }

  logger.info(`Found ${due.length} due outreach session(s)`);

  // One browser + one AI chat for the whole batch (rotate after 15–25 rounds)
  const context = await openBrowserContext();
  const batch = new OutreachBatchChat(context);
  await startTracing(context);
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;

  try {
    for (const row of rotateForWorker(due)) {
      if (await isRetryCoolingDown(row.pageId)) {
        logger.info(`Skip session (technical retry cooldown): ${row.pageId}`);
        skipCount++;
        continue;
      }

      const token = await acquireLock("session", row.pageId);
      if (!token) {
        logger.info(`Skip session (locked): ${row.pageId}`);
        skipCount++;
        continue;
      }

      // The due list is a snapshot: rows ahead in the batch take minutes each, so
      // by now another worker's AI run may already have advanced this Session.
      // Claiming a row that is no longer due is what dragged completed plans back
      // into a run and ultimately rewrote their schedule.
      let fresh: Awaited<ReturnType<typeof loadSession>>;
      try {
        fresh = await loadSession(row.pageUrl);
      } catch (e) {
        await releaseLock("session", row.pageId, token);
        logger.warn(`Re-read failed for ${row.pageId}`, e);
        failCount++;
        continue;
      }

      if (!isSchedulerEligible(fresh.status, fresh.nextAction, fresh.nextWakeAt)) {
        await releaseLock("session", row.pageId, token);
        logger.info(`Skip session (no longer due): ${row.pageId}`, {
          status: fresh.status,
          nextAction: fresh.nextAction,
          nextWakeAt: fresh.nextWakeAt,
        });
        skipCount++;
        continue;
      }

      const drift = await guardPlanDrift(fresh);
      if (drift) {
        await releaseLock("session", row.pageId, token);
        logger.warn(`Skip session (plan drift healed): ${row.pageId}`, {
          wakeAt: drift.wakeAt,
          plannedAt: drift.plannedAt,
          nextAction: drift.nextAction,
        });
        skipCount++;
        continue;
      }

      try {
        await claimSession(row.pageId);
      } catch (e) {
        await releaseLock("session", row.pageId, token);
        logger.warn(`Claim failed for ${row.pageId}`, e);
        failCount++;
        continue;
      }

      logger.info(`Claimed session ${row.pageId}`, { nextWakeAt: row.nextWakeAt });
      const job: OutreachJob = {
        sessionPageUrl: row.pageUrl,
        lockToken: token,
        queuedAt: new Date().toISOString(),
      };

      try {
        const result = await processOutreachJob(job, batch);
        logger.info(`Outreach job finished`, { ...result });
        if (result.ok) okCount++;
        else if (result.skipped) skipCount++;
        else failCount++;
      } catch (e) {
        failCount++;
        logger.error("Unhandled outreach job error", e);
        // processOutreachJob releases lock in finally; if it threw before that,
        // release here as safety.
        await releaseLock("session", row.pageId, token).catch(() => undefined);
      }
    }
  } finally {
    await stopTracing(context, {
      recordId: "batch",
      runId: `outreach-${Date.now()}`,
    }).catch(() => undefined);
    await batch.close();
    await closeBrowserContext(context);
  }

  const byStatus = await countSessionsByStatus().catch(() => ({}));
  logger.info("Outreach poll summary", {
    sessions_by_status: byStatus,
    reclaimed: reclaim.reclaimed,
    reconciled: reclaim.reconciled,
    batch_ok: okCount,
    batch_fail: failCount,
    batch_skip: skipCount,
  });
}

export async function pollAndProcessMailbox(limit = 10): Promise<void> {
  const due = await fetchDueMailboxes(limit);
  const jobs: MailboxJob[] = [];
  const skipped: Array<{ pageId: string; reason: string }> = [];

  for (const row of due) {
    const token = await acquireLock("mailbox", row.pageId);
    if (!token) {
      skipped.push({ pageId: row.pageId, reason: "lock_held" });
      continue;
    }
    jobs.push({
      mailboxPageUrl: row.pageUrl,
      lockToken: token,
      queuedAt: new Date().toISOString(),
    });
    logger.info(`Locked mailbox ${row.pageId}`, { nextScanAt: row.nextScanAt });
  }

  if (skipped.length) logger.info(`Skipped ${skipped.length} mailboxes`, { skipped });
  if (!jobs.length) {
    logger.info("No due mailboxes");
    return;
  }

  const context = await openBrowserContext();
  try {
    for (const job of jobs) {
      const result = await processMailboxJob(job, context);
      logger.info(`Mailbox job finished`, { ...result });
    }
  } finally {
    await closeBrowserContext(context);
  }
}

export async function pollOnce(queues: Array<"outreach" | "mailbox">): Promise<void> {
  if (queues.includes("outreach")) await pollAndProcessOutreach();
  if (queues.includes("mailbox")) await pollAndProcessMailbox();
}
