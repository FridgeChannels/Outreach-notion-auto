import { type BrowserContext, type Page } from "playwright";
import {
  buildOutreachMessage,
  CHAT_RUN_TIMEOUT_MS,
  LOCK_HEARTBEAT_INTERVAL_MS,
  OUTREACH_CONTROLLER_PROMPT_URL,
  MAILBOX_REPLY_SCAN_PROMPT_URL,
  NEXT_ACTION,
  RUNNING_VISIBILITY_GRACE_MS,
  SESSION_STATUS,
  SESSION_WRITEBACK_TIMEOUT_MS,
  WORKER_ID,
} from "../config.js";
import { detectExecutionPhase, errorCategoryFromPhase, SkipError, InvalidCompletionError, RunningVisibilityError } from "../errors.js";
import {
  decideErrorAction,
  isRealConversationUrl,
  validateSessionBeforeBrowser,
} from "./validators.js";
import { type OutreachBatchChat } from "./chatReuse.js";
import {
  loadSession,
  markRunning,
  saveConversationUrl,
  clearWorkerTechnicalErrorIfSafe,
  scheduleTechnicalRetry,
  markAmbiguousOrError,
  waitForSessionWriteback,
  validateSuccessfulSessionUpdate,
  sessionSnapshot,
  releaseClaimToPending,
  reconcileSessionFromControlJson,
  waitForRunningVisibility,
} from "../notion/sessionRepository.js";
import { parsePageUrl } from "../notion/helpers.js";
import {
  validateLock,
  releaseLock,
  startLockHeartbeat,
  buildExecutionKey,
  acquireExecutionLock,
  markExecutionSubmitted,
  releaseExecutionLock,
  clearExecutionLock,
} from "../locks.js";
import { NotionAiChatPage } from "../pages/notionAiChatPage.js";
import {
  makeRunId,
  saveScreenshot,
  saveSnapshot,
  startTracing,
  stopTracing,
  type ArtifactContext,
} from "../artifacts.js";
import { logger, type RunLogEntry } from "../logging.js";

export type OutreachJob = {
  sessionPageUrl: string;
  lockToken: string;
  queuedAt: string;
};

export interface ProcessResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Persist Conversation URL only after it is a durable chat route and reopens cleanly.
 */
async function persistVerifiedConversationUrl(
  context: BrowserContext,
  chatPage: NotionAiChatPage,
  sessionPageId: string,
  conversationUrl: string,
): Promise<string> {
  if (
    !isRealConversationUrl(conversationUrl, [
      OUTREACH_CONTROLLER_PROMPT_URL,
      MAILBOX_REPLY_SCAN_PROMPT_URL,
    ])
  ) {
    throw new Error(`Invalid conversation URL: ${conversationUrl}`);
  }

  const verifyPage = await context.newPage();
  try {
    await verifyPage.goto(conversationUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await chatPage.verifyExistingConversationLoaded(verifyPage);
  } finally {
    await verifyPage.close().catch(() => undefined);
  }

  await saveConversationUrl(sessionPageId, conversationUrl);
  logger.info("Verified and saved Conversation URL", { url: conversationUrl });
  return conversationUrl;
}

/**
 * Process one Outreach Session using the batch-shared AI chat (reuse until rotate).
 */
export async function processOutreachJob(
  job: OutreachJob,
  batch: OutreachBatchChat,
): Promise<ProcessResult> {
  const startedAt = new Date();
  const lockPageId = parsePageUrl(job.sessionPageUrl);

  let session: Awaited<ReturnType<typeof loadSession>>;
  try {
    session = await loadSession(job.sessionPageUrl);
  } catch (e) {
    if (lockPageId) await releaseLock("session", lockPageId, job.lockToken);
    throw e;
  }

  const statusBefore = session.status;
  const runId = makeRunId(session.sessionId);
  const artifactCtx: ArtifactContext = { recordId: session.sessionId, runId };

  const executionKey = buildExecutionKey(
    session.sessionId,
    session.wakePayloadEventId,
    session.nextAction,
  );
  let executionToken: string | null = null;

  const chatPage = batch.chatPage;
  let page: Page | null = null;
  let heartbeat: { stop: () => void } | null = null;
  let tracingSaved = false;

  const runLog: RunLogEntry = {
    kind: "outreach",
    record_id: session.sessionId,
    page_url: job.sessionPageUrl,
    conversation_url: session.conversationUrl,
    worker_id: WORKER_ID,
    started_at: startedAt.toISOString(),
    submitted_at: null,
    completed_at: null,
    status_before: statusBefore,
    status_after: null,
    retry_count: session.retryCount,
    error_category: null,
  };

  try {
    if (!(await validateLock("session", session.pageId, job.lockToken))) {
      throw new SkipError("Lock no longer held by this worker");
    }
    validateSessionBeforeBrowser(session);

    executionToken = await acquireExecutionLock(executionKey);
    if (!executionToken) {
      throw new SkipError(`Duplicate execution blocked: ${executionKey}`);
    }

    // Mark Running ASAP (before browser prep). Claimed+empty Last Run At looks
    // "stale" to other workers' reclaim watchdog; setting Last Run At early
    // plus lock-aware reclaim prevents Status flipping back to Pending.
    if (!session.nextAction) {
      throw new SkipError("Next Action is empty before submit");
    }
    await markRunning(session.pageId, startedAt);
    heartbeat = startLockHeartbeat(
      "session",
      session.pageId,
      job.lockToken,
      LOCK_HEARTBEAT_INTERVAL_MS,
    );
    await waitForRunningVisibility(
      job.sessionPageUrl,
      { nextAction: session.nextAction, clientPageId: session.clientPageId! },
      startedAt,
    );

    const prepared = await batch.prepareForJob(session.model);
    page = prepared.page;
    let conversationUrl = prepared.conversationUrl;
    runLog.conversation_url = conversationUrl;

    const latest = await loadSession(job.sessionPageUrl);
    if (!(await validateLock("session", session.pageId, job.lockToken))) {
      throw new SkipError("Lock lost before submit");
    }
    if (latest.clientPageId !== session.clientPageId) {
      throw new SkipError("Client relation changed before submit");
    }
    if (latest.clientDnc) throw new SkipError("DNC enabled before submit");
    if (latest.status !== SESSION_STATUS.RUNNING) {
      throw new RunningVisibilityError(
        `Status flipped to ${latest.status} before submit (expected Running)`,
      );
    }
    if (RUNNING_VISIBILITY_GRACE_MS > 0) {
      await new Promise((r) => setTimeout(r, RUNNING_VISIBILITY_GRACE_MS));
    }
    // Final re-read right before AI send — catch late reclaim/consistency flip.
    const ready = await loadSession(job.sessionPageUrl);
    if (ready.status !== SESSION_STATUS.RUNNING) {
      throw new RunningVisibilityError(
        `Status flipped to ${ready.status} at submit gate (expected Running)`,
      );
    }

    const message = buildOutreachMessage(latest.clientPageUrl!);
    await chatPage.submitAndWait(page, message, CHAT_RUN_TIMEOUT_MS);
    runLog.submitted_at = new Date().toISOString();

    // Capture / refresh durable Conversation URL after submit when missing
    if (!conversationUrl || !isRealConversationUrl(conversationUrl, [
      OUTREACH_CONTROLLER_PROMPT_URL,
      MAILBOX_REPLY_SCAN_PROMPT_URL,
    ])) {
      try {
        const captured = await chatPage.waitForConversationUrl(page, page.url(), 8_000);
        if (batch.lastPrepareRotated) {
          conversationUrl = await persistVerifiedConversationUrl(
            batch.context,
            chatPage,
            session.pageId,
            captured,
          );
        } else {
          await saveConversationUrl(session.pageId, captured);
          conversationUrl = captured;
        }
        runLog.conversation_url = conversationUrl;
      } catch (e) {
        const fallback = await chatPage.captureConversationUrl(page, 5_000);
        if (fallback) {
          if (batch.lastPrepareRotated) {
            conversationUrl = await persistVerifiedConversationUrl(
              batch.context,
              chatPage,
              session.pageId,
              fallback,
            );
          } else {
            await saveConversationUrl(session.pageId, fallback);
            conversationUrl = fallback;
          }
          runLog.conversation_url = conversationUrl;
        } else {
          logger.warn(
            `Could not capture durable Conversation URL after submit: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    } else {
      // Same shared chat — stamp URL onto this Session without re-verify every time
      await saveConversationUrl(session.pageId, conversationUrl);
      runLog.conversation_url = conversationUrl;
    }

    logger.info("Waiting for Session writeback (Status leaving Running/Claimed)…");
    let updated = await waitForSessionWriteback(
      job.sessionPageUrl,
      startedAt,
      SESSION_WRITEBACK_TIMEOUT_MS,
    );
    try {
      validateSuccessfulSessionUpdate(updated, startedAt);
    } catch (validationErr) {
      if (!(validationErr instanceof InvalidCompletionError)) throw validationErr;
      const reconciled = await reconcileSessionFromControlJson(updated);
      if (!reconciled) throw validationErr;
      updated = reconciled;
      validateSuccessfulSessionUpdate(updated, startedAt);
      logger.info("Session writeback reconciled from Last Control JSON", {
        status: updated.status,
        nextAction: updated.nextAction,
      });
    }

    if (
      updated.nextAction === NEXT_ACTION.EXECUTE_EMAIL &&
      !updated.hasLatestInteraction
    ) {
      logger.warn(
        "Execute Email without Latest Interaction — Prompt may have skipped Interaction create",
        { sessionId: session.sessionId, pageId: session.pageId },
      );
    }

    await markExecutionSubmitted(executionKey, executionToken, conversationUrl);
    batch.recordSuccessfulRound(conversationUrl);

    const cleared = await clearWorkerTechnicalErrorIfSafe(updated);
    if (!cleared) {
      logger.info(
        `Preserved Last Error / business reason on status=${updated.status}`,
        { lastError: updated.lastError, wakeReason: updated.wakeReason },
      );
    }

    runLog.status_after = updated.status;
    runLog.completed_at = new Date().toISOString();
    logger.run(runLog);
    return { ok: true };
  } catch (error) {
    const phase = detectExecutionPhase(error, chatPage.wasSubmitted());
    runLog.error_category = errorCategoryFromPhase(phase);
    runLog.completed_at = new Date().toISOString();

    await saveScreenshot(page, artifactCtx, "failure");
    if (!tracingSaved) {
      await stopTracing(batch.context, artifactCtx);
      tracingSaved = true;
    }
    await saveSnapshot(artifactCtx, {
      label: "failure",
      error: error instanceof Error ? error.message : String(error),
      phase,
      session: sessionSnapshot(session),
      batch: {
        roundsUsed: batch.roundsUsed,
        rotateAt: batch.rotateAt,
        conversationUrl: batch.conversationUrl,
      },
    });

    if (error instanceof SkipError) {
      runLog.status_after = statusBefore;
      // Batch pre-claims leave Status=Claimed; if the lock expired while waiting
      // in queue, put back to Pending so the next poll can pick it up.
      if (/lock/i.test(error.message)) {
        try {
          await releaseClaimToPending(session.pageId);
          runLog.status_after = SESSION_STATUS.PENDING;
        } catch (releaseErr) {
          logger.warn("Failed to release claim after lock skip", releaseErr);
        }
      }
      logger.run(runLog);
      logger.info(`Skipped: ${error.message}`);
      return { ok: false, skipped: true, error: error.message };
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    const action = decideErrorAction(
      phase,
      session.retryCount,
      chatPage.wasSubmitted(),
      errMsg,
    );
    if (action === "technical-retry") {
      await clearExecutionLock(executionKey);
      await scheduleTechnicalRetry(session.pageId, errMsg, session.retryCount);
      runLog.status_after = SESSION_STATUS.PENDING;
      logger.run(runLog);
      logger.warn(`Technical retry (Status=Pending): ${errMsg}`);
      return { ok: false, error: errMsg };
    }

    await markAmbiguousOrError(
      session.pageId,
      error instanceof Error ? error.message : String(error),
      phase,
    );
    runLog.status_after = SESSION_STATUS.ERROR;
    logger.run(runLog);
    logger.error("Outreach job failed", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    heartbeat?.stop();
    if (executionToken) {
      await releaseExecutionLock(executionKey, executionToken, {
        onlyIfNotSubmitted: true,
      });
    }
    await releaseLock("session", session.pageId, job.lockToken);
    // Keep batch.page open for the next Session in this poll cycle
  }
}
