import type { Page } from "playwright";
import { UI_ACTION_TIMEOUT_MS } from "../config.js";
import { AuthenticationError } from "../errors.js";

const LOGIN_PATTERNS = [
  /accounts\.google\.com/i,
  /login\.microsoftonline\.com/i,
  /notion\.so\/login/i,
  /notion\.so\/signup/i,
  /notion\.com\/login/i,
];

export class NotionLoginPage {
  async assertLoggedIn(page: Page): Promise<void> {
    const url = page.url();
    for (const pattern of LOGIN_PATTERNS) {
      if (pattern.test(url)) {
        throw new AuthenticationError(`Redirected to login page: ${url}`);
      }
    }
    const loginButton = page.getByRole("link", { name: /log in|sign in|登录/i });
    if ((await loginButton.isVisible().catch(() => false)) && /notion\.(so|com)/.test(url)) {
      throw new AuthenticationError("Notion login required");
    }
    // Blank about:blank before first goto — skip body checks
    if (!url || url === "about:blank") return;

    const body = await page.locator("body").innerText().catch(() => "");
    if (/log in to notion|sign in to continue|登录以继续|Continue with Google|用 Google 账号/i.test(body)) {
      throw new AuthenticationError(`Notion login wall detected at ${url}`);
    }
  }

  async waitForWorkspaceReady(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: UI_ACTION_TIMEOUT_MS });
    await this.assertLoggedIn(page);
  }
}
