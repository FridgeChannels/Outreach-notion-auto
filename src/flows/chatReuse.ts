import type { BrowserContext, Page } from "playwright";
import {
  CHAT_REUSE_MAX_ROUNDS,
  CHAT_REUSE_MIN_ROUNDS,
  NOTION_AI_MODEL_DEFAULT,
  OUTREACH_CONTROLLER_PROMPT_URL,
} from "../config.js";
import { NotionAiChatPage } from "../pages/notionAiChatPage.js";
import { NotionLoginPage } from "../pages/notionLoginPage.js";
import { NotionWorkspacePage } from "../pages/notionWorkspacePage.js";
import { logger } from "../logging.js";

/** Inclusive random rotate limit in [min, max]. */
export function pickChatRotateLimit(
  min = CHAT_REUSE_MIN_ROUNDS,
  max = CHAT_REUSE_MAX_ROUNDS,
): number {
  const lo = Math.max(1, Math.min(min, max));
  const hi = Math.max(lo, Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * One shared Notion AI chat for a batch of Outreach Session jobs.
 * Reuses the same panel until `roundsUsed` hits a random 15–25 limit, then New chat.
 */
export class OutreachBatchChat {
  readonly context: BrowserContext;
  readonly chatPage = new NotionAiChatPage();
  page: Page | null = null;
  conversationUrl: string | null = null;
  /** Successful AI turns in the current chat thread. */
  roundsUsed = 0;
  rotateAt: number;
  /** True after the last prepareForJob opened/rotated a chat. */
  lastPrepareRotated = false;

  constructor(context: BrowserContext, rotateAt = pickChatRotateLimit()) {
    this.context = context;
    this.rotateAt = rotateAt;
    logger.info("Outreach batch chat reuse enabled", {
      rotateAt,
      min: CHAT_REUSE_MIN_ROUNDS,
      max: CHAT_REUSE_MAX_ROUNDS,
    });
  }

  async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    return this.page;
  }

  /**
   * Ensure a usable AI composer for the next Session job.
   * - First job / after rotate limit: smoke + New chat
   * - Otherwise: stay in the current chat (no navigation)
   */
  async prepareForJob(model?: string | null): Promise<{
    page: Page;
    conversationUrl: string | null;
    rotated: boolean;
  }> {
    const page = await this.ensurePage();
    const modelName = model?.trim() || NOTION_AI_MODEL_DEFAULT;
    this.chatPage.resetSubmittedFlag();

    const shouldRotate = this.roundsUsed > 0 && this.roundsUsed >= this.rotateAt;
    const composerReady = await this.chatPage.hasReadyComposer(page);
    const needFreshChat = !composerReady || (this.roundsUsed === 0 && !this.conversationUrl);

    if (needFreshChat && !shouldRotate) {
      await new NotionWorkspacePage().smokeTestOutreach(page, "");
      await new NotionLoginPage().assertLoggedIn(page);
      this.conversationUrl = await this.chatPage.createConversation(
        page,
        OUTREACH_CONTROLLER_PROMPT_URL,
      );
      await this.chatPage.ensureModel(page, modelName);
      this.lastPrepareRotated = true;
      logger.info("Opened batch AI chat", {
        conversationUrl: this.conversationUrl,
        rotateAt: this.rotateAt,
      });
      return { page, conversationUrl: this.conversationUrl, rotated: true };
    }

    if (shouldRotate) {
      logger.info("Rotating batch AI chat", {
        roundsUsed: this.roundsUsed,
        rotateAt: this.rotateAt,
      });
      this.conversationUrl = await this.chatPage.rotateToNewChat(
        page,
        OUTREACH_CONTROLLER_PROMPT_URL,
      );
      await this.chatPage.ensureModel(page, modelName);
      this.roundsUsed = 0;
      this.rotateAt = pickChatRotateLimit();
      this.lastPrepareRotated = true;
      logger.info("Batch AI chat rotated", {
        conversationUrl: this.conversationUrl,
        nextRotateAt: this.rotateAt,
      });
      return { page, conversationUrl: this.conversationUrl, rotated: true };
    }

    await this.chatPage.ensureComposerReady(page);
    await this.chatPage.ensureModel(page, modelName);
    this.lastPrepareRotated = false;
    logger.info("Reusing batch AI chat", {
      roundsUsed: this.roundsUsed,
      rotateAt: this.rotateAt,
      conversationUrl: this.conversationUrl,
    });
    return { page, conversationUrl: this.conversationUrl, rotated: false };
  }

  /** Call after a successful Session turn (submit + writeback OK). */
  recordSuccessfulRound(conversationUrl?: string | null): void {
    if (conversationUrl) this.conversationUrl = conversationUrl;
    this.roundsUsed += 1;
    logger.info("Batch AI chat round recorded", {
      roundsUsed: this.roundsUsed,
      rotateAt: this.rotateAt,
    });
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => undefined);
      this.page = null;
    }
  }
}
