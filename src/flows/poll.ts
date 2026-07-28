import { acquireLock, releaseLock } from "../locks.js";
import {
  claimSession,
  countSessionsByStatus,
  fetchDueSessions,
  reclaimStuckSessions,
} from "../notion/sessionRepository.js";
import { fetchDueMailboxes } from "../notion/mailboxRepository.js";
import { closeBrowserContext, openBrowserContext } from "../browser.js";
import { OutreachBatchChat } from "./chatReuse.js";
import { processOutreachJob, type OutreachJob } from "./processOutreach.js";
import { processMailboxJob, type MailboxJob } from "./processMailbox.js";
import { logger } from "../logging.js";
import { startTracing, stopTracing } from "../artifacts.js";

/**
 * Lazy claim: lock + claim one Session at a time inside the batch loop.
 * Avoids pre-claiming the whole due set (which left Claimed orphans when
 * waiting locks expired mid-batch).
 */
export async function pollAndProcessOutreach(limit = 20): Promise<void> {
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
    for (const row of due) {
      const token = await acquireLock("session", row.pageId);
      if (!token) {
        logger.info(`Skip session (locked): ${row.pageId}`);
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
