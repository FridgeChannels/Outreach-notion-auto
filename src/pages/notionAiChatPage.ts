import type { Page, Response } from "playwright";
import {
  CHAT_RUN_TIMEOUT_MS,
  NOTION_AI_MODEL_DEFAULT,
  UI_ACTION_TIMEOUT_MS,
  AI_PANEL_TIMEOUT_MS,
  OUTREACH_CONTROLLER_PROMPT_URL,
  MAILBOX_REPLY_SCAN_PROMPT_URL,
  toChatEntryUrl,
} from "../config.js";
import { ConversationError, AmbiguousExecutionError, AuthenticationError } from "../errors.js";
import { isRealConversationUrl, knownPromptUrls } from "../flows/validators.js";
import { logger } from "../logging.js";
import { NotionLoginPage } from "./notionLoginPage.js";

const ASSISTANT_CORNER = ".notion-assistant-corner-origin-container";
const AI_FACE = `${ASSISTANT_CORNER} div.notion-ai-button[role="button"][aria-label="ai"]`;
/** Prefer panel-scoped inputs; placeholder text varies by locale/Notion version. */
const AI_INPUT_SELECTORS = [
  `${ASSISTANT_CORNER} [data-content-editable-leaf="true"][placeholder*="AI"]`,
  `${ASSISTANT_CORNER} [data-content-editable-leaf="true"]`,
  '[data-content-editable-leaf="true"][placeholder="Do anything with AI…"]',
  '[data-content-editable-leaf="true"][placeholder*="Do anything with AI"]',
  '[data-content-editable-leaf="true"][placeholder*="Ask AI"]',
  '[data-content-editable-leaf="true"][placeholder*="Notion AI"]',
  '[data-testid="agent-composer"] [data-content-editable-leaf="true"]',
  '[data-testid="agent-message-input"]',
];
const SEND_BUTTON = '[data-testid="agent-send-message-button"]';
const STOP_BUTTON = '[data-testid="agent-stop-inference-button"]';
const NEW_CHAT_BUTTON = '[aria-label="Start new chat"]';
const UNIFIED_MODEL_BUTTON = 'div[data-testid="unified-chat-model-button"]';
const PERSONALIZE_DIALOG = '[role="dialog"][aria-label="Personalize your Notion AI"]';

const AI_STABLE_WINDOW_MS = 8_000;
const POLL_MS = 500;
const MODAL_WAIT_MS = 1000;
/** Extra settle after New chat — matches dashboard MODAL_WAIT cadence. */
const NEW_CHAT_SETTLE_MS = 1_500;
const TYPE_DELAY_MS = 30;
const MENTION_CONFIRM_WAIT_MS = 1_000;
const URL_CAPTURE_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Same Notion page if origin+pathname match (ignore query/hash). */
function samePageUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin + ua.pathname === ub.origin + ub.pathname;
  } catch {
    return a === b;
  }
}

function normalizeModelLabel(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "").replace(/beta/gi, "").trim();
}

function normalizeInputCompare(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function prompts(): string[] {
  return knownPromptUrls([OUTREACH_CONTROLLER_PROMPT_URL, MAILBOX_REPLY_SCAN_PROMPT_URL]);
}

function extractHttpUrls(message: string): string[] {
  return [...message.matchAll(/https?:\/\/[^\s\u200B]+/gi)].map((m) => m[0]);
}

/**
 * Find a *visible* AI composer leaf. Notion sometimes keeps hidden duplicates;
 * typing into those looks like "no input" while Playwright still "succeeds".
 */
export async function resolveChatInput(page: Page) {
  for (const sel of AI_INPUT_SELECTORS) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = loc.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width < 40 || box.height < 12) continue;
      return candidate;
    }
  }
  // Last resort: first matcher (may throw later on wait)
  return page.locator(AI_INPUT_SELECTORS[2]!).first();
}

async function clearChatInput(page: Page): Promise<void> {
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAll);
  await page.keyboard.press("Backspace");
  await sleep(50);
}

async function readChatInputText(page: Page): Promise<string> {
  const input = await resolveChatInput(page);
  return input.evaluate((el) => (el as HTMLElement).innerText ?? "").catch(() => "");
}

function extractPageIds(message: string): string[] {
  const ids: string[] = [];
  for (const url of extractHttpUrls(message)) {
    const m =
      url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ??
      url.match(/([0-9a-f]{32})/i);
    if (m?.[1]) ids.push(m[1].replace(/-/g, "").toLowerCase());
  }
  return ids;
}

function messageLooksPresent(actual: string, message: string): boolean {
  const text = normalizeInputCompare(actual).replace(/\u200B/g, "");
  if (!text.includes("请运行")) return false;
  for (const url of extractHttpUrls(message)) {
    if (text.includes(url) || text.includes(url.replace(/-/g, ""))) continue;
    // After @mention resolve, composer may show page title instead of raw URL
    const id =
      url.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ??
      url.match(/([0-9a-f]{32})/i)?.[1];
    if (id && (text.includes(id) || text.includes(id.replace(/-/g, "")))) continue;
    // Mention chips often drop the URL entirely — require at least page-id count via mentions/links
    // Fall through: if every expected id is missing from raw text, still allow if we typed @mentions
    // and text has enough non-empty content after "请运行".
  }
  const ids = extractPageIds(message);
  if (ids.length === 0) return text.length >= 8;
  const found = ids.filter(
    (id) => text.toLowerCase().includes(id) || text.toLowerCase().includes(
      `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
    ),
  );
  // Mentions may render as titled chips without UUID — require instruction + roughly enough length
  if (found.length >= ids.length) return true;
  return text.includes("@") || text.length >= Math.min(40, message.length / 2);
}

/**
 * Notion auto-link often swallows following lines into one <a href="url1 执行公司：url2">.
 * Detect that before send so we never submit a merged link.
 */
export async function hasMergedNotionLinks(
  page: Page,
  message: string,
): Promise<{ merged: boolean; detail: string }> {
  const urls = extractHttpUrls(message);
  if (urls.length < 2) return { merged: false, detail: "ok" };

  const input = await resolveChatInput(page);
  return input.evaluate((el, expectedUrls: string[]) => {
    const anchors = Array.from(el.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    for (const a of anchors) {
      const href = (a.getAttribute("href") || "").trim();
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      const httpCount = (href.match(/https?:\/\//gi) || []).length;
      if (httpCount > 1) {
        return { merged: true, detail: `href has ${httpCount} urls: ${href.slice(0, 180)}` };
      }
      if (/执行|公司|邮箱|Prompt|请运行/i.test(href) || /\s/.test(href)) {
        return { merged: true, detail: `href looks glued: ${href.slice(0, 180)}` };
      }
      const matchedExpected = expectedUrls.filter(
        (u) => text.includes(u) || href.includes(u) || text.includes(u.replace(/-/g, "")),
      );
      if (matchedExpected.length >= 2) {
        return { merged: true, detail: `anchor text covers ${matchedExpected.length} urls` };
      }
    }
    const html = el.innerHTML;
    const idA = expectedUrls[0]?.match(/[0-9a-f]{8}-[0-9a-f]{4}/i)?.[0];
    const idB = expectedUrls[1]?.match(/[0-9a-f]{8}-[0-9a-f]{4}/i)?.[0];
    if (idA && idB) {
      const hrefMatch = html.match(/href="([^"]+)"/gi) || [];
      for (const h of hrefMatch) {
        if (h.includes(idA) && h.includes(idB)) {
          return { merged: true, detail: `single href contains both page ids: ${h.slice(0, 180)}` };
        }
      }
    }
    return { merged: false, detail: "ok" };
  }, urls);
}

/**
 * Fill chat like notion-auto dashboard: keyboard.type the full template.
 * Confirm @mentions with Enter ONLY when a mention picker is open — otherwise
 * Enter submits the composer early (partial message + empty input → false failure).
 */
export async function typeMultilineChatInput(page: Page, message: string): Promise<void> {
  await typeMentionStyleChatInput(page, message);
}

/** Notion page-mention / link suggestion popup (not survey listboxes). */
async function isMentionPickerVisible(page: Page): Promise<boolean> {
  const listboxes = page.locator('[role="listbox"]');
  const n = await listboxes.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const lb = listboxes.nth(i);
    if (!(await lb.isVisible().catch(() => false))) continue;
    const ad = (await lb.getAttribute("aria-activedescendant").catch(() => null)) || "";
    if (ad.startsWith("survey-option-")) continue;
    return true;
  }
  if (
    await page
      .locator('[data-testid*="mention-menu"], [data-testid*="mention-popup"]')
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    return true;
  }
  return false;
}

async function confirmMentionIfPickerOpen(page: Page): Promise<boolean> {
  const deadline = Date.now() + MENTION_CONFIRM_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isMentionPickerVisible(page)) {
      await page.keyboard.press("Enter");
      await sleep(150);
      return true;
    }
    await sleep(80);
  }
  return false;
}

async function typeMentionStyleChatInput(page: Page, message: string): Promise<void> {
  const parts = message.split(/(@https?:\/\/\S+)/g).filter((p) => p.length > 0);
  let mentionCount = 0;
  let confirmed = 0;

  for (const part of parts) {
    // Never continue typing into a running generation
    if (await page.locator(STOP_BUTTON).first().isVisible().catch(() => false)) {
      logger.warn("Stop visible while typing — leaving composer (message may already be submitting)");
      break;
    }
    if (/^@https?:\/\//i.test(part)) {
      mentionCount += 1;
      await page.keyboard.type(part, { delay: TYPE_DELAY_MS });
      if (await confirmMentionIfPickerOpen(page)) {
        confirmed += 1;
      } else {
        // No picker: keep raw @url / auto-link in the composer; do NOT press Enter
        logger.info("No mention picker after @url; skipped Enter to avoid early submit");
      }
    } else {
      await page.keyboard.type(part, { delay: TYPE_DELAY_MS });
    }
  }
  await sleep(300);
  logger.info("Chat input filled with @mention-style typing", {
    chars: message.length,
    mentionCount,
    confirmed,
  });
}

export class NotionAiChatPage {
  private submitted = false;
  private seenChatUrls = new Set<string>();

  wasSubmitted(): boolean {
    return this.submitted;
  }

  resetSubmittedFlag(): void {
    this.submitted = false;
  }

  /** Attach early to catch chat thread URLs from network while creating/submitting. */
  attachUrlCapture(page: Page): void {
    page.on("response", (response: Response) => {
      void this.considerResponseUrl(response);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.considerCandidateUrl(frame.url());
      }
    });
  }

  async openConversation(page: Page, conversationUrl: string): Promise<void> {
    if (!isRealConversationUrl(conversationUrl, prompts())) {
      throw new ConversationError(
        `Conversation URL looks like a Prompt page or new-chat stub: ${conversationUrl}`,
      );
    }
    const response = await page.goto(conversationUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    if (response && response.status() >= 400) {
      throw new ConversationError(`Conversation unavailable (HTTP ${response.status()})`);
    }
    const forbidden = page.getByText(/don't have access|无权限|page not found|找不到|已删除/i);
    if (await forbidden.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      throw new ConversationError("Conversation unavailable");
    }
    // Side-panel chat may need AI opened even when URL is a chat permalink
    if (!(await this.isChatInputReady(page))) {
      await this.openAiPanel(page).catch(() => undefined);
    }
    await this.waitForChatReady(page);
    logger.info("Opened existing conversation", { url: conversationUrl });
  }

  /**
   * Open AI panel + New Chat. Chat input ready is the gate — do NOT wait for a
   * durable Conversation URL here (Notion often stays on Prompt ?t=new for a long
   * time). Capture URL after submit instead so typing is not delayed ~30–45s.
   */
  async createConversation(page: Page, entryUrl: string): Promise<string | null> {
    this.attachUrlCapture(page);
    const entry = toChatEntryUrl(entryUrl);
    // Avoid double-goto after smoke (Notion SPA often fails to mount AI corner on re-nav)
    if (!samePageUrl(page.url(), entry)) {
      logger.info("Navigating to chat entry URL", { url: entry, raw: entryUrl });
      await page.goto(entry, { waitUntil: "domcontentloaded", timeout: 90_000 });
    } else {
      logger.info("Already on chat entry URL; skipping re-goto", { url: entry });
    }
    await this.dismissDialogs(page);
    await sleep(MODAL_WAIT_MS);
    await new NotionLoginPage().assertLoggedIn(page);

    if (!(await this.isChatInputReady(page))) {
      logger.info("AI chat input not visible yet; opening AI panel");
      await this.openAiPanel(page);
    }
    await this.dismissDialogs(page);
    await this.clickNewChat(page);
    await this.dismissDialogs(page);
    await sleep(NEW_CHAT_SETTLE_MS);
    await this.waitForChatReady(page);
    logger.info("Chat input ready; proceeding to type (Conversation URL capture deferred)");

    // Brief opportunistic capture only — never block typing for long
    const url = await this.captureConversationUrl(page, 2_000);
    if (url) {
      logger.info("Created new conversation", { url });
      return url;
    }
    return null;
  }

  /**
   * Wait until we have a durable Agent conversation URL.
   * Notion often keeps the Prompt /p/ path and only changes `?t=` from `new` → thread id;
   * after submit the current page URL may already be durable — accept it immediately.
   */
  async waitForConversationUrl(
    page: Page,
    initialUrl: string,
    timeoutMs = 30_000,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    const initialWasDurable = isRealConversationUrl(initialUrl, prompts());
    while (Date.now() < deadline) {
      this.considerCandidateUrl(page.url());
      for (const candidate of this.seenChatUrls) {
        if (!isRealConversationUrl(candidate, prompts())) continue;
        // Prefer a URL that appeared / changed after a stub start; if we already
        // started on a durable URL (post-submit), that candidate is fine.
        if (!initialWasDurable || candidate === page.url() || candidate !== initialUrl) {
          return candidate;
        }
      }
      const fromDom = await this.extractChatUrlFromDom(page).catch(() => null);
      if (fromDom) {
        this.considerCandidateUrl(fromDom);
        if (isRealConversationUrl(fromDom, prompts())) return fromDom;
      }
      const current = page.url();
      if (isRealConversationUrl(current, prompts())) return current;
      await sleep(300);
    }
    throw new ConversationError(
      `Timed out waiting for durable Conversation URL (still ${page.url()})`,
    );
  }

  async verifyExistingConversationLoaded(page: Page): Promise<void> {
    if (!(await this.isChatInputReady(page))) {
      await this.openAiPanel(page).catch(() => undefined);
    }
    await this.waitForChatReady(page);
  }

  async ensureModel(page: Page, model: string): Promise<void> {
    const target = model.trim() || NOTION_AI_MODEL_DEFAULT;
    const btn = page.locator(UNIFIED_MODEL_BUTTON).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      logger.warn("Model button not visible; skipping model selection");
      return;
    }
    const current = normalizeModelLabel(await btn.innerText().catch(() => ""));
    const want = normalizeModelLabel(target);
    if (current.includes(want) || (want === "auto" && current.includes("auto"))) {
      return;
    }
    await btn.click();
    await sleep(400);
    const dialog = page.locator('div[role="dialog"][aria-modal="true"]');
    await dialog.waitFor({ state: "visible", timeout: UI_ACTION_TIMEOUT_MS });
    const items = dialog.locator('[role="menuitem"]');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const text = await item.innerText().catch(() => "");
      if (normalizeModelLabel(text).includes(want)) {
        await item.click();
        await sleep(400);
        logger.info(`Model selected: ${target}`);
        return;
      }
    }
    throw new ConversationError(`Model not found in picker: ${target}`);
  }

  async submitAndWait(page: Page, message: string, timeoutMs = CHAT_RUN_TIMEOUT_MS): Promise<void> {
    await this.fillAndSend(page, message);
    this.submitted = true;
    logger.info("Message submitted to chat — waiting for AI (input will look empty now)");

    try {
      await this.waitForAiCompletion(page, timeoutMs);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNotionAiBlip = /Something went wrong|dismiss the error|rate limit/i.test(msg);
      if (!isNotionAiBlip) throw e;

      // Transient Notion AI failure: dismiss blockers and resubmit once in the same chat
      logger.warn(`Notion AI failed after submit; dismissing and retrying once: ${msg}`);
      await this.dismissDialogs(page).catch(() => undefined);
      await this.dismissAiErrorBanner(page).catch(() => undefined);
      await sleep(800);
      if (!(await this.isChatInputReady(page))) {
        await this.openAiPanel(page).catch(() => undefined);
        await this.waitForChatReady(page);
      }
      await this.fillAndSend(page, message);
      logger.info("Retry submit sent — waiting for AI again");
      await this.waitForAiCompletion(page, timeoutMs);
    }
  }

  private async fillAndSend(page: Page, message: string): Promise<void> {
    await this.dismissDialogs(page).catch(() => undefined);
    const input = await resolveChatInput(page);
    await input.waitFor({ state: "visible", timeout: UI_ACTION_TIMEOUT_MS });

    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    // Match dashboard: click center of input, short delay, then type
    const box = await input.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    } else {
      await input.click({ timeout: UI_ACTION_TIMEOUT_MS });
    }
    await sleep(150);

    await clearChatInput(page);
    logger.info("Typing chat message into visible AI input…", {
      messageChars: message.length,
      preview: message.slice(0, 80).replace(/\n/g, "\\n"),
    });
    await typeMultilineChatInput(page, message);

    const send = page.locator(SEND_BUTTON).first();
    const stop = page.locator(STOP_BUTTON).first();

    // Enter-on-mention (legacy) or accidental submit: Stop means already generating
    if (await stop.isVisible().catch(() => false)) {
      logger.info("Stop visible after fill — treating as already submitted");
      return;
    }

    // @mentions rarely create merged bare-href links; still refuse if glued
    const merge = await hasMergedNotionLinks(page, message);
    if (merge.merged) {
      throw new ConversationError(`Refusing to send merged Notion links: ${merge.detail}`);
    }

    const actual = normalizeInputCompare(await readChatInputText(page)).replace(/\u200B/g, "");
    logger.info("Chat input content before send", {
      chars: actual.length,
      preview: actual.slice(0, 120).replace(/\n/g, "\\n"),
    });
    if (!messageLooksPresent(actual, message)) {
      throw new ConversationError(
        `Visible chat input missing required content after fill (chars=${actual.length})`,
      );
    }

    await send.waitFor({ state: "visible", timeout: UI_ACTION_TIMEOUT_MS });
    if ((await send.getAttribute("aria-disabled").catch(() => null)) === "true") {
      throw new ConversationError("Send button disabled");
    }
    await send.click();
  }

  /** Best-effort capture of a durable chat URL (not Prompt/?t=new). */
  async captureConversationUrl(page: Page, timeoutMs = URL_CAPTURE_MS): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const candidate of this.seenChatUrls) {
        if (isRealConversationUrl(candidate, prompts())) return candidate;
      }
      this.considerCandidateUrl(page.url());
      if (isRealConversationUrl(page.url(), prompts())) return page.url();
      try {
        const fromDom = await this.extractChatUrlFromDom(page);
        if (fromDom) {
          this.considerCandidateUrl(fromDom);
          if (isRealConversationUrl(fromDom, prompts())) return fromDom;
        }
      } catch (e) {
        logger.warn(
          `extractChatUrlFromDom failed (non-fatal): ${e instanceof Error ? e.message : e}`,
        );
      }
      await sleep(300);
    }
    for (const candidate of this.seenChatUrls) {
      if (isRealConversationUrl(candidate, prompts())) return candidate;
    }
    return null;
  }

  private async isChatInputReady(page: Page): Promise<boolean> {
    try {
      const input = await resolveChatInput(page);
      const visible = await input.isVisible().catch(() => false);
      if (!visible) return false;
      const box = await input.boundingBox().catch(() => null);
      return Boolean(box && box.width >= 40 && box.height >= 12);
    } catch {
      return false;
    }
  }

  private async waitForChatReady(page: Page): Promise<void> {
    const deadline = Date.now() + UI_ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isChatInputReady(page)) return;
      await sleep(200);
    }
    throw new ConversationError("Visible Notion AI chat input not found");
  }

  private async openAiPanel(page: Page): Promise<void> {
    if (await this.isChatInputReady(page)) return;

    await this.dismissDialogs(page).catch(() => undefined);
    await new NotionLoginPage().assertLoggedIn(page);

    if (
      await page
        .getByText(/Oops, there was an error loading this page/i)
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      throw new ConversationError(`Notion page failed to load: ${page.url()}`);
    }

    const timeoutMs = AI_PANEL_TIMEOUT_MS;
    const container = page.locator(ASSISTANT_CORNER).first();
    try {
      await container.waitFor({ state: "attached", timeout: timeoutMs });
    } catch {
      // Fallback: some layouts expose ai button without the corner wrapper yet
      const alt = page.locator('div.notion-ai-button[role="button"][aria-label="ai"]').first();
      if (await alt.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await alt.click();
        await sleep(MODAL_WAIT_MS);
        await this.dismissDialogs(page);
        return;
      }
      const diag = await this.diagnoseMissingAiPanel(page);
      throw new ConversationError(
        `Notion AI panel not found within ${timeoutMs}ms. ${diag}`,
      );
    }

    const closeInCorner = container.locator('div[role="button"][aria-label="Close"]').first();
    if (await closeInCorner.isVisible().catch(() => false)) {
      await closeInCorner.click();
      await sleep(300);
    }
    const entry = page.locator(AI_FACE).first();
    await entry.waitFor({ state: "visible", timeout: timeoutMs });
    await entry.locator("xpath=..").click();
    await sleep(MODAL_WAIT_MS);
    await this.dismissDialogs(page);
  }

  private async diagnoseMissingAiPanel(page: Page): Promise<string> {
    const info = await page
      .evaluate(() => {
        const body = (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 180);
        return {
          url: location.href,
          title: document.title,
          hasLogin: /log in|sign in|登录|繼續|Continue with/i.test(body),
          hasOops: /oops|error loading/i.test(body),
          aiButtons: document.querySelectorAll(
            '[aria-label="ai"], .notion-ai-button, .notion-assistant-corner-origin-container',
          ).length,
          bodyPreview: body,
        };
      })
      .catch(() => ({ url: page.url(), title: "", hasLogin: false, hasOops: false, aiButtons: 0, bodyPreview: "" }));

    if (info.hasLogin) {
      throw new AuthenticationError(
        `Notion login required (url=${info.url}). Re-run: npm run worker:login -- --account=<name> and deploy auth/<account>.json`,
      );
    }
    return `url=${info.url} title=${JSON.stringify(info.title)} oops=${info.hasOops} aiNodes=${info.aiButtons} body=${JSON.stringify(info.bodyPreview)}`;
  }

  private considerCandidateUrl(url: string): void {
    if (!url?.trim()) return;
    // Never keep API / asset response URLs — they are not navigable chat pages
    try {
      const u = new URL(url);
      if (u.pathname.includes("/api/") || u.pathname.startsWith("/api")) return;
    } catch {
      return;
    }
    if (!isRealConversationUrl(url, prompts())) return;
    this.seenChatUrls.add(url);
  }

  private async considerResponseUrl(response: Response): Promise<void> {
    try {
      const url = response.url();
      // Do not treat the request URL itself as a conversation URL (often /api/v3/...)
      // Notion sometimes returns chat/thread ids in JSON bodies
      const ct = response.headers()["content-type"] ?? "";
      if (!ct.includes("application/json")) return;
      if (!/chat|thread|agent|conversation|inference/i.test(url)) return;
      const text = await response.text().catch(() => "");
      const matches = text.match(
        /https:\/\/(?:www\.)?(?:notion\.so|app\.notion\.com)\/[^\s"'\\]+/g,
      );
      if (matches) {
        for (const m of matches) this.considerCandidateUrl(m.replace(/\\u002F/g, "/"));
      }
      const idMatch = text.match(/"(?:chatId|threadId|conversationId|agentChatId)"\s*:\s*"([^"]+)"/);
      if (idMatch?.[1]) {
        this.considerCandidateUrl(`https://www.notion.so/chat/${idMatch[1]}`);
      }
    } catch {
      // ignore body parse errors
    }
  }

  private async extractChatUrlFromDom(page: Page): Promise<string | null> {
    // Keep this evaluate body free of nested named helpers — tsx/esbuild injects
    // `__name(...)` for keepNames, which breaks inside the browser sandbox.
    return page.evaluate(`(() => {
      const durable = (href) => {
        try {
          const u = new URL(href, location.href);
          const t = u.searchParams.get("t");
          if (t && t.toLowerCase() !== "new" && /^[0-9a-f-]{20,}$/i.test(t)) return true;
          if (/\\/chat\\//i.test(u.pathname)) return true;
          if (u.searchParams.has("threadId") || u.searchParams.has("chatId")) return true;
          return false;
        } catch {
          return false;
        }
      };
      if (durable(location.href)) return location.href;
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const a of anchors) {
        const href = a.href || "";
        if (durable(href) || /agent.*chat/i.test(href)) return href;
      }
      const copy = document.querySelector(
        '[aria-label*="Copy link" i], [aria-label*="Copy chat" i], [data-testid*="copy-link"]',
      );
      if (copy) {
        const nearby = copy.closest("a") && copy.closest("a").href;
        if (nearby && durable(nearby)) return nearby;
      }
      return null;
    })()`);
  }

  private async clickNewChat(page: Page): Promise<void> {
    const stop = page.locator(STOP_BUTTON).first();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      await sleep(400);
    }
    const candidates = [
      page.locator(NEW_CHAT_BUTTON).first(),
      page.getByRole("button", { name: /start new chat|new chat|新对话|新建对话/i }).first(),
      page.locator('[aria-label*="new chat" i]').first(),
      page.locator('[data-testid*="new-chat" i]').first(),
    ];
    for (const btn of candidates) {
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        await sleep(MODAL_WAIT_MS);
        return;
      }
    }
    logger.warn("New chat button not visible; continuing with current AI panel");
  }

  private async dismissDialogs(page: Page): Promise<void> {
    const dialog = page.locator(PERSONALIZE_DIALOG).first();
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "Done" }).click().catch(() => undefined);
      await sleep(300);
    }

    // "Open in Notion's desktop app?" — Escape / stay-in-browser; uncheck Always open
    const openAppText = page.getByText(/Open in Notion'?s desktop app/i);
    if (await openAppText.first().isVisible().catch(() => false)) {
      logger.warn("Dismissing Notion desktop-app dialog");
      const unchecked = await page.evaluate(() => {
        const labels = Array.from(document.querySelectorAll("label, span, div"));
        const hit = labels.find((el) => /Always open in app/i.test(el.textContent || ""));
        if (!hit) return false;
        const root = hit.closest("label") || hit.parentElement;
        const input = root?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
        if (input?.checked) {
          input.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (unchecked) logger.info("Unchecked Always open in app");

      const stay = page.getByRole("button", {
        name: /Not now|Cancel|Close|Stay|Continue in browser|稍后|取消|继续在浏览器/i,
      });
      await stay.first().click({ timeout: 1200 }).catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(150);
      await page.keyboard.press("Escape").catch(() => undefined);
      // Click page background to dismiss overlay if still present
      await page.mouse.click(24, 24).catch(() => undefined);
      await sleep(200);
    }

    // Notion AI error banner: "Something went wrong…" + X, blocks composer
    await this.dismissAiErrorBanner(page);
  }

  /** Click the X on the red AI error strip so the composer unlocks. */
  private async dismissAiErrorBanner(page: Page): Promise<boolean> {
    const errText = page.getByText(/Something went wrong while processing your request/i);
    if (!(await errText.first().isVisible().catch(() => false))) {
      const blocked = page.getByText(/Please dismiss the error to continue/i);
      if (!(await blocked.first().isVisible().catch(() => false))) return false;
    }

    logger.warn("Dismissing Notion AI error banner");
    const clicked = await page.evaluate(() => {
      const match = Array.from(document.querySelectorAll("div,span,p")).find((el) =>
        /Something went wrong while processing your request/i.test(el.textContent || ""),
      );
      if (!match) return false;
      let root: HTMLElement | null = match as HTMLElement;
      for (let i = 0; i < 6 && root; i++) {
        const btn = root.querySelector(
          'button, [role="button"], [aria-label="Close"], [aria-label="Dismiss"], [aria-label="close"]',
        ) as HTMLElement | null;
        if (btn) {
          btn.click();
          return true;
        }
        root = root.parentElement;
      }
      return false;
    }).catch(() => false);

    if (!clicked) {
      // Fallback: any close near the error / Escape
      await page
        .locator('[aria-label="Close"], [aria-label="Dismiss"]')
        .last()
        .click({ timeout: 1000 })
        .catch(() => undefined);
      await page.keyboard.press("Escape").catch(() => undefined);
    }
    await sleep(400);
    return true;
  }

  /** Detect Notion AI fatal banners that look like "idle" but mean the run failed. */
  async detectChatRuntimeError(page: Page): Promise<string | null> {
    return page.evaluate(() => {
      const body = document.body?.innerText ?? "";
      if (/Something went wrong while processing your request/i.test(body)) {
        return "Notion AI: Something went wrong while processing your request";
      }
      if (/Please dismiss the error to continue/i.test(body)) {
        return "Notion AI error banner blocking chat input";
      }
      if (/Rate limit|too many requests/i.test(body)) {
        return "Notion AI rate limited";
      }
      return null;
    });
  }

  private async waitForAiCompletion(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const stop = page.locator(STOP_BUTTON).first();
    const send = page.locator(SEND_BUTTON).first();
    let sawStop = false;
    let sawNonEmptyAssistant = false;
    let sawRuntimeError: string | null = null;

    while (Date.now() < deadline) {
      await this.dismissDialogs(page).catch(() => undefined);

      const runtimeErr = await this.detectChatRuntimeError(page);
      if (runtimeErr) {
        sawRuntimeError = runtimeErr;
        // Keep error visible long enough for logs, then unlock composer for optional retry
        logger.warn(`Notion AI runtime error during wait: ${runtimeErr}`);
        await this.dismissAiErrorBanner(page);
        throw new AmbiguousExecutionError(`${runtimeErr} (submitted but AI did not finish)`);
      }

      if (await stop.isVisible().catch(() => false)) {
        sawStop = true;
        await sleep(POLL_MS);
        continue;
      }

      const summary = await this.getLastAiMessageSummary(page).catch(() => "");
      // Ignore empty / greeting-only panels after a crash (looks like a fresh New chat)
      const isGreetingOnly =
        !summary.trim() ||
        /^how can i help you today/i.test(summary.trim()) ||
        /summarize this page/i.test(summary);
      if (summary.trim().length > 0 && !isGreetingOnly) sawNonEmptyAssistant = true;

      if (await send.isVisible().catch(() => false)) {
        if (!sawStop && !sawNonEmptyAssistant) {
          await sleep(POLL_MS);
          continue;
        }
        if (await this.aiMessageStable(page, AI_STABLE_WINDOW_MS)) {
          const errAfter = await this.detectChatRuntimeError(page);
          if (errAfter || sawRuntimeError) {
            throw new AmbiguousExecutionError(
              `${errAfter || sawRuntimeError} (submitted but AI did not finish)`,
            );
          }
          return;
        }
      }
      await sleep(POLL_MS);
    }
    throw new AmbiguousExecutionError("Chat run timeout — ambiguous execution state");
  }

  private async aiMessageStable(page: Page, windowMs: number): Promise<boolean> {
    const getLast = async () =>
      page.evaluate(() => {
        const nodes = document.querySelectorAll('[data-testid="agent-message"]');
        return nodes[nodes.length - 1]?.textContent?.trim() ?? "";
      });
    const t0 = await getLast();
    await sleep(windowMs);
    const t1 = await getLast();
    const stopVisible = await page.locator(STOP_BUTTON).first().isVisible().catch(() => false);
    return t0 === t1 && !stopVisible;
  }

  async getLastAiMessageSummary(page: Page): Promise<string> {
    return page.evaluate(() => {
      const nodes = document.querySelectorAll('[data-testid="agent-message"]');
      const full = nodes[nodes.length - 1]?.textContent?.trim() ?? "";
      return full.length > 500 ? full.slice(0, 500) + "…" : full;
    });
  }
}
