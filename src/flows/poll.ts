import { acquireLock, releaseLock } from "../locks.js";
import { claimSession, fetchDueSessions } from "../notion/sessionRepository.js";
import { fetchDueMailboxes } from "../notion/mailboxRepository.js";
import { closeBrowserContext, openBrowserContext } from "../browser.js";
import { processOutreachJob, type OutreachJob } from "./processOutreach.js";
import { processMailboxJob, type MailboxJob } from "./processMailbox.js";
import { logger } from "../logging.js";

export async function pollAndProcessOutreach(limit = 20): Promise<void> {
  const due = await fetchDueSessions(limit);
  const jobs: OutreachJob[] = [];
  const skipped: Array<{ pageId: string; reason: string }> = [];

  for (const row of due) {
    const token = await acquireLock("session", row.pageId);
    if (!token) {
      skipped.push({ pageId: row.pageId, reason: "lock_held" });
      continue;
    }
    try {
      await claimSession(row.pageId);
      jobs.push({
        sessionPageUrl: row.pageUrl,
        lockToken: token,
        queuedAt: new Date().toISOString(),
      });
      logger.info(`Claimed session ${row.pageId}`, { nextWakeAt: row.nextWakeAt });
    } catch (e) {
      await releaseLock("session", row.pageId, token);
      skipped.push({
        pageId: row.pageId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (skipped.length) logger.info(`Skipped ${skipped.length} sessions`, { skipped });
  if (!jobs.length) {
    logger.info("No due outreach sessions");
    return;
  }

  // One browser context per batch (same account). Multi-account = multiple workers.
  const context = await openBrowserContext();
  try {
    for (const job of jobs) {
      const result = await processOutreachJob(job, context);
      logger.info(`Outreach job finished`, { ...result });
    }
  } finally {
    await closeBrowserContext(context);
  }
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
