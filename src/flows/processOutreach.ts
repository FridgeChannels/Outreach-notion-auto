import { type BrowserContext, type Page } from "playwright";
import {
  buildOutreachMessage,
  CHAT_RUN_TIMEOUT_MS,
  LOCK_HEARTBEAT_INTERVAL_MS,
  MAX_TECHNICAL_RETRIES,
  NOTION_AI_MODEL_DEFAULT,
  OUTREACH_CONTROLLER_PROMPT_URL,
  MAILBOX_REPLY_SCAN_PROMPT_URL,
  SESSION_STATUS,
  SESSION_WRITEBACK_TIMEOUT_MS,
  WORKER_ID,
} from "../config.js";
import { openPersistentBrowserContext, closeBrowserContext } from "../browser.js";
import { detectExecutionPhase, errorCategoryFromPhase, SkipError } from "../errors.js";
import {
  decideErrorAction,
  isRealConversationUrl,
  validateSessionBeforeBrowser,
  validateSessionBeforeSubmit,
} from "./validators.js";
import {
  loadSession,
  markRunning,
  saveConversationUrl,
  clearWorkerTechnicalErrorIfSafe,
  scheduleTechnicalRetry,
  markAmbiguousOrError,
  releaseClaimToPending,
  waitForSessionWriteback,
  validateSuccessfulSessionUpdate,
  sessionSnapshot,
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
import { NotionLoginPage } from "../pages/notionLoginPage.js";
import { NotionWorkspacePage } from "../pages/notionWorkspacePage.js";
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

export async function processOutreachJob(
  job: OutreachJob,
  sharedContext?: BrowserContext,
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

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const ownsContext = !sharedContext;
  const chatPage = new NotionAiChatPage();
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

    context = sharedContext ?? (await openPersistentBrowserContext());
    if (ownsContext) await startTracing(context);
    page = await context.newPage();

    await new NotionWorkspacePage().smokeTestOutreach(page, session.clientPageUrl!);
    await new NotionLoginPage().assertLoggedIn(page);
    logger.info("Smoke ok; creating/opening AI chat");

    let conversationUrl = session.conversationUrl;
    if (
      conversationUrl &&
      !isRealConversationUrl(conversationUrl, [
        OUTREACH_CONTROLLER_PROMPT_URL,
        MAILBOX_REPLY_SCAN_PROMPT_URL,
      ])
    ) {
      logger.warn(`Ignoring stub Conversation URL, will create a new chat: ${conversationUrl}`);
      await saveConversationUrl(session.pageId, "");
      conversationUrl = null;
      runLog.conversation_url = null;
    }

    if (conversationUrl) {
      await chatPage.openConversation(page, conversationUrl);
    } else {
      conversationUrl = await chatPage.createConversation(page, OUTREACH_CONTROLLER_PROMPT_URL);
      await chatPage.ensureModel(page, session.model || NOTION_AI_MODEL_DEFAULT);
      if (conversationUrl) {
        conversationUrl = await persistVerifiedConversationUrl(
          context,
          chatPage,
          session.pageId,
          conversationUrl,
        );
        session = { ...session, conversationUrl };
        runLog.conversation_url = conversationUrl;
      }
    }

    const latest = await loadSession(job.sessionPageUrl);
    if (!(await validateLock("session", session.pageId, job.lockToken))) {
      throw new SkipError("Lock lost before submit");
    }
    validateSessionBeforeSubmit(latest, session.clientPageId);
    await markRunning(latest.pageId, startedAt);

    heartbeat = startLockHeartbeat(
      "session",
      session.pageId,
      job.lockToken,
      LOCK_HEARTBEAT_INTERVAL_MS,
    );

    const message = buildOutreachMessage(latest.clientPageUrl!);
    await chatPage.submitAndWait(page, message, CHAT_RUN_TIMEOUT_MS);
    runLog.submitted_at = new Date().toISOString();
    // Do NOT markExecutionSubmitted yet — only after Session writeback succeeds.
    // Otherwise a Notion AI crash after click would permanently block this wake event.

    if (!conversationUrl) {
      try {
        // Short capture only — do not block 30s after a successful chat turn
        const captured = await chatPage.waitForConversationUrl(page, page.url(), 8_000);
        conversationUrl = await persistVerifiedConversationUrl(
          context,
          chatPage,
          session.pageId,
          captured,
        );
        runLog.conversation_url = conversationUrl;
      } catch (e) {
        const fallback = await chatPage.captureConversationUrl(page, 5_000);
        if (fallback) {
          conversationUrl = await persistVerifiedConversationUrl(
            context,
            chatPage,
            session.pageId,
            fallback,
          );
          runLog.conversation_url = conversationUrl;
        } else {
          logger.warn(
            `Could not capture durable Conversation URL after submit: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    }

    logger.info("Waiting for Session writeback (Status leaving Running/Claimed)…");
    const updated = await waitForSessionWriteback(
      job.sessionPageUrl,
      startedAt,
      SESSION_WRITEBACK_TIMEOUT_MS,
    );
    validateSuccessfulSessionUpdate(updated, startedAt);
    // Only now: this wake+action completed successfully — block duplicate resubmit
    await markExecutionSubmitted(executionKey, executionToken, conversationUrl);
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
    if (context && !tracingSaved) {
      await stopTracing(context, artifactCtx);
      tracingSaved = true;
    }

    const refreshed = await loadSession(job.sessionPageUrl).catch(() => session);
    await saveSnapshot(artifactCtx, {
      ...sessionSnapshot(refreshed),
      phase,
      submitted: chatPage.wasSubmitted(),
      page_url: page?.url() ?? null,
      execution_key: executionKey,
      last_ai_summary: page ? await chatPage.getLastAiMessageSummary(page).catch(() => "") : "",
    });

    if (error instanceof SkipError) {
      if (refreshed.status === SESSION_STATUS.CLAIMED) {
        await releaseClaimToPending(session.pageId);
        runLog.status_after = SESSION_STATUS.PENDING;
      } else {
        runLog.status_after = refreshed.status;
      }
      logger.run(runLog);
      logger.info(`Skipped: ${error.message}`);
      return { ok: false, skipped: true, error: error.message };
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    // Notion AI "Something went wrong" after UI submit: no Session writeback yet —
    // treat as technical retry so the next poll can resubmit (execution lock not marked submitted).
    const transientNotionAi =
      /Something went wrong|dismiss the error|rate limit/i.test(errMsg) &&
      session.retryCount < MAX_TECHNICAL_RETRIES;
    const action = transientNotionAi
      ? "technical-retry"
      : decideErrorAction(phase, session.retryCount, chatPage.wasSubmitted());
    if (action === "technical-retry") {
      // Allow the same wake+action to run again after a failed attempt
      await clearExecutionLock(executionKey);
      await scheduleTechnicalRetry(session.pageId, errMsg, session.retryCount);
      runLog.status_after = SESSION_STATUS.PENDING;
      logger.run(runLog);
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
      // Keep lock if submitted so retries cannot recreate chat / resubmit
      await releaseExecutionLock(executionKey, executionToken, {
        onlyIfNotSubmitted: true,
      });
    }
    await releaseLock("session", session.pageId, job.lockToken);
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context && ownsContext) {
      try {
        if (!tracingSaved) await stopTracing(context, artifactCtx);
        await closeBrowserContext(context);
      } catch {
        // ignore
      }
    }
  }
}
