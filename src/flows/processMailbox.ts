import { type BrowserContext, type Page } from "playwright";
import {
  buildMailboxMessage,
  CHAT_RUN_TIMEOUT_MS,
  LOCK_HEARTBEAT_INTERVAL_MS,
  MAILBOX_REPLY_SCAN_PROMPT_URL,
  OUTREACH_CONTROLLER_PROMPT_URL,
  MAILBOX_STATUS,
  NOTION_AI_MODEL_DEFAULT,
  WORKER_ID,
} from "../config.js";
import { openPersistentBrowserContext } from "../browser.js";
import { detectExecutionPhase, errorCategoryFromPhase, SkipError } from "../errors.js";
import { decideErrorAction, isRealConversationUrl, validateMailboxBeforeBrowser } from "./validators.js";
import {
  loadMailbox,
  markScanning,
  saveMailboxConversationUrl,
  markMailboxError,
  releaseScanningToActive,
  validateSuccessfulMailboxUpdate,
  mailboxSnapshot,
} from "../notion/mailboxRepository.js";
import { parsePageUrl } from "../notion/helpers.js";
import { validateLock, releaseLock, startLockHeartbeat } from "../locks.js";
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

export type MailboxJob = {
  mailboxPageUrl: string;
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
  mailboxPageId: string,
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

  await saveMailboxConversationUrl(mailboxPageId, conversationUrl);
  logger.info("Verified and saved Mailbox Conversation URL", { url: conversationUrl });
  return conversationUrl;
}

export async function processMailboxJob(
  job: MailboxJob,
  sharedContext?: BrowserContext,
): Promise<ProcessResult> {
  const startedAt = new Date();
  const lockPageId = parsePageUrl(job.mailboxPageUrl);

  let mailbox: Awaited<ReturnType<typeof loadMailbox>>;
  try {
    mailbox = await loadMailbox(job.mailboxPageUrl);
  } catch (e) {
    if (lockPageId) await releaseLock("mailbox", lockPageId, job.lockToken);
    throw e;
  }

  const statusBefore = mailbox.status;
  const runId = makeRunId(mailbox.pageId);
  const artifactCtx: ArtifactContext = { recordId: mailbox.pageId, runId };

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const ownsContext = !sharedContext;
  const chatPage = new NotionAiChatPage();
  let heartbeat: { stop: () => void } | null = null;
  let tracingSaved = false;

  const runLog: RunLogEntry = {
    kind: "mailbox",
    record_id: mailbox.pageId,
    page_url: job.mailboxPageUrl,
    conversation_url: mailbox.conversationUrl,
    worker_id: WORKER_ID,
    started_at: startedAt.toISOString(),
    submitted_at: null,
    completed_at: null,
    status_before: statusBefore,
    status_after: null,
    retry_count: 0,
    error_category: null,
  };

  try {
    if (!(await validateLock("mailbox", mailbox.pageId, job.lockToken))) {
      throw new SkipError("Lock no longer held by this worker");
    }
    validateMailboxBeforeBrowser(mailbox);

    context = sharedContext ?? (await openPersistentBrowserContext());
    if (ownsContext) await startTracing(context);
    page = await context.newPage();

    await new NotionWorkspacePage().smokeTestMailbox(page, mailbox.pageUrl);
    await new NotionLoginPage().assertLoggedIn(page);

    await markScanning(mailbox.pageId, startedAt);

    let conversationUrl = mailbox.conversationUrl;
    if (
      conversationUrl &&
      !isRealConversationUrl(conversationUrl, [
        OUTREACH_CONTROLLER_PROMPT_URL,
        MAILBOX_REPLY_SCAN_PROMPT_URL,
      ])
    ) {
      logger.warn(`Ignoring stub Conversation URL, will create a new chat: ${conversationUrl}`);
      await saveMailboxConversationUrl(mailbox.pageId, "");
      conversationUrl = null;
      runLog.conversation_url = null;
    }

    if (conversationUrl) {
      await chatPage.openConversation(page, conversationUrl);
    } else {
      conversationUrl = await chatPage.createConversation(page, MAILBOX_REPLY_SCAN_PROMPT_URL);
      await chatPage.ensureModel(page, mailbox.model || NOTION_AI_MODEL_DEFAULT);
      if (conversationUrl) {
        conversationUrl = await persistVerifiedConversationUrl(
          context,
          chatPage,
          mailbox.pageId,
          conversationUrl,
        );
        mailbox = { ...mailbox, conversationUrl };
        runLog.conversation_url = conversationUrl;
      }
    }

    if (!(await validateLock("mailbox", mailbox.pageId, job.lockToken))) {
      throw new SkipError("Lock lost before submit");
    }

    heartbeat = startLockHeartbeat(
      "mailbox",
      mailbox.pageId,
      job.lockToken,
      LOCK_HEARTBEAT_INTERVAL_MS,
    );

    const message = buildMailboxMessage(mailbox.pageUrl);
    await chatPage.submitAndWait(page, message, CHAT_RUN_TIMEOUT_MS);
    runLog.submitted_at = new Date().toISOString();

    if (!conversationUrl) {
      try {
        const captured = await chatPage.waitForConversationUrl(page, page.url(), 30_000);
        conversationUrl = await persistVerifiedConversationUrl(
          context,
          chatPage,
          mailbox.pageId,
          captured,
        );
        runLog.conversation_url = conversationUrl;
      } catch (e) {
        const fallback = await chatPage.captureConversationUrl(page, 10_000);
        if (fallback) {
          conversationUrl = await persistVerifiedConversationUrl(
            context,
            chatPage,
            mailbox.pageId,
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

    const updated = await loadMailbox(job.mailboxPageUrl);
    validateSuccessfulMailboxUpdate(updated, startedAt);

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

    const refreshed = await loadMailbox(job.mailboxPageUrl).catch(() => mailbox);
    await saveSnapshot(artifactCtx, {
      ...mailboxSnapshot(refreshed),
      phase,
      submitted: chatPage.wasSubmitted(),
      page_url: page?.url() ?? null,
    });

    if (error instanceof SkipError) {
      if (refreshed.status === MAILBOX_STATUS.SCANNING) {
        await releaseScanningToActive(mailbox.pageId);
        runLog.status_after = MAILBOX_STATUS.ACTIVE;
      } else {
        runLog.status_after = refreshed.status;
      }
      logger.run(runLog);
      logger.info(`Skipped: ${error.message}`);
      return { ok: false, skipped: true, error: error.message };
    }

    const action = decideErrorAction(phase, 0, chatPage.wasSubmitted());
    if (action === "technical-retry" && refreshed.status === MAILBOX_STATUS.SCANNING) {
      await releaseScanningToActive(mailbox.pageId);
      runLog.status_after = MAILBOX_STATUS.ACTIVE;
      logger.run(runLog);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    await markMailboxError(
      mailbox.pageId,
      error instanceof Error ? error.message : String(error),
    );
    runLog.status_after = MAILBOX_STATUS.ERROR;
    logger.run(runLog);
    logger.error("Mailbox job failed", error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    heartbeat?.stop();
    await releaseLock("mailbox", mailbox.pageId, job.lockToken);
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (context && ownsContext) {
      try {
        if (!tracingSaved) await stopTracing(context, artifactCtx);
        await context.close();
      } catch {
        // ignore
      }
    }
  }
}
