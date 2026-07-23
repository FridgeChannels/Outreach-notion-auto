import type { Page } from "playwright";
import {
  OUTREACH_CONTROLLER_PROMPT_URL,
  MAILBOX_REPLY_SCAN_PROMPT_URL,
  toChatEntryUrl,
} from "../config.js";
import { ConversationError } from "../errors.js";
import { NotionLoginPage } from "./notionLoginPage.js";
import { logger } from "../logging.js";

export class NotionWorkspacePage {
  private loginPage = new NotionLoginPage();

  async openPage(page: Page, url: string): Promise<void> {
    const entry = toChatEntryUrl(url);
    await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await this.loginPage.waitForWorkspaceReady(page);
  }

  async validateAccessible(page: Page, url: string, label: string): Promise<void> {
    await this.openPage(page, url);
    const forbidden = page.getByText(/don't have access|无权限|没有权限|page not found|找不到/i);
    if (await forbidden.first().isVisible().catch(() => false)) {
      throw new ConversationError(`${label} inaccessible: ${toChatEntryUrl(url)}`);
    }
  }

  async smokeTestOutreach(page: Page, _clientPageUrl: string): Promise<void> {
    // Do NOT open Client first — that makes the UI look "loaded" for a long time
    // with no chat typing. Controller Prompt reachability is enough before chat.
    logger.info("Smoke: checking Controller Prompt is accessible", {
      url: toChatEntryUrl(OUTREACH_CONTROLLER_PROMPT_URL),
    });
    await this.validateAccessible(page, OUTREACH_CONTROLLER_PROMPT_URL, "Controller Prompt");
  }

  async smokeTestMailbox(page: Page, _mailboxPageUrl: string): Promise<void> {
    logger.info("Smoke: checking Mailbox Scan Prompt is accessible", {
      url: toChatEntryUrl(MAILBOX_REPLY_SCAN_PROMPT_URL),
    });
    await this.validateAccessible(page, MAILBOX_REPLY_SCAN_PROMPT_URL, "Mailbox Scan Prompt");
  }
}
