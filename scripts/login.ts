import "dotenv/config";
import { configurePlaywrightTempDir, openPersistentBrowserContext, preflightBrowserEnvironment } from "../src/browser.js";
import { NOTION_PROFILE_DIR } from "../src/config.js";

async function main(): Promise<void> {
  await preflightBrowserEnvironment();
  await configurePlaywrightTempDir();

  const dir = NOTION_PROFILE_DIR || "./profiles/outreach-worker";
  console.log(`Opening browser; profile dir: ${dir}`);
  console.log(`Playwright TMPDIR: ${process.env.TMPDIR}`);
  console.log("Log in to Notion, then press Enter in this terminal to save and exit.\n");

  // Prefer shared launcher (temp dir + retries + stale lock clear).
  // Login is interactive → force headed via env if needed.
  if (process.env.PLAYWRIGHT_HEADLESS === "true") {
    console.warn("PLAYWRIGHT_HEADLESS=true — set false for interactive login.");
  }

  const context = await openPersistentBrowserContext();
  const page = await context.newPage();
  await page.goto("https://www.notion.so", { waitUntil: "domcontentloaded", timeout: 90_000 });

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  await context.close();
  console.log(`Login saved to ${dir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
