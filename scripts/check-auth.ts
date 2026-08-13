import "dotenv/config";
import {
  configurePlaywrightTempDir,
  openBrowserContext,
  closeBrowserContext,
} from "../src/browser.js";
import { resolveAuthStatePath, listAuthAccounts } from "../src/auth.js";
import { NotionLoginPage } from "../src/pages/notionLoginPage.js";
import { OUTREACH_CONTROLLER_PROMPT_URL, toChatEntryUrl } from "../src/config.js";

const ASSISTANT_CORNER = ".notion-assistant-corner-origin-container";
const LOGIN_HINT =
  /即将完成|登录即可|log in to notion|sign in to continue|Continue with Google|邮件地址|用 Google 账号/i;

async function checkAccount(account: string) {
  const authPath = resolveAuthStatePath(account);
  const target = toChatEntryUrl(OUTREACH_CONTROLLER_PROMPT_URL || "https://www.notion.so");
  const context = await openBrowserContext({ authPath, headless: true });
  const page = await context.newPage();
  const result: Record<string, unknown> = { account, authPath, target };
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 90_000 });
    // SPA may need a few seconds after cookies apply
    await page.waitForTimeout(4000);
    result.url = page.url();
    result.title = await page.title().catch(() => "");
    let body = ((await page.locator("body").innerText().catch(() => "")) || "")
      .replace(/\s+/g, " ")
      .slice(0, 220);
    // Hayes-like slow paint: wait a bit more if still blank
    if (!body.trim()) {
      await page.waitForTimeout(6000);
      body = ((await page.locator("body").innerText().catch(() => "")) || "")
        .replace(/\s+/g, " ")
        .slice(0, 220);
      result.url = page.url();
      result.title = await page.title().catch(() => "");
    }
    result.bodyPreview = body;
    let loginOk = true;
    let loginErr = "";
    try {
      await new NotionLoginPage().assertLoggedIn(page);
    } catch (e) {
      loginOk = false;
      loginErr = e instanceof Error ? e.message : String(e);
    }
    const loginWallUi = LOGIN_HINT.test(body);
    // Give AI corner up to ~20s to mount (servers/local headless often slow)
    let aiAttached = false;
    const aiDeadline = Date.now() + 20_000;
    while (Date.now() < aiDeadline) {
      aiAttached = await page
        .locator(ASSISTANT_CORNER)
        .first()
        .count()
        .then((c) => c > 0)
        .catch(() => false);
      if (aiAttached) break;
      await page.waitForTimeout(500);
    }
    const aiVisible = await page
      .locator(ASSISTANT_CORNER)
      .first()
      .isVisible()
      .catch(() => false);
    result.loggedIn = loginOk && !loginWallUi;
    result.loginError = loginErr || (loginWallUi ? "login wall UI detected" : null);
    result.aiCornerAttached = aiAttached;
    result.aiCornerVisible = aiVisible;
    result.status = !result.loggedIn
      ? "AUTH_DEAD"
      : aiAttached
        ? "OK"
        : "LOGGED_IN_NO_AI_CORNER";
  } catch (e) {
    result.status = "ERROR";
    result.error = e instanceof Error ? e.message.split("\n")[0] : String(e);
  } finally {
    await closeBrowserContext(context);
  }
  return result;
}

async function main(): Promise<void> {
  await configurePlaywrightTempDir();
  const accounts = await listAuthAccounts();
  console.log("Accounts:", accounts.join(", "));
  console.log("Controller:", OUTREACH_CONTROLLER_PROMPT_URL || "(fallback notion.so)");
  const rows = [];
  for (const a of accounts) {
    process.stderr.write(`Checking ${a}...\n`);
    const r = await checkAccount(a);
    rows.push(r);
    console.log(JSON.stringify(r));
  }
  console.log("\n=== SUMMARY ===");
  for (const r of rows) {
    const extra = r.loginError || r.error || "";
    console.log(`${r.account}: ${r.status}${extra ? ` | ${extra}` : ""}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
