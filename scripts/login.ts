import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

async function main(): Promise<void> {
  const dir = process.env.NOTION_PROFILE_DIR?.trim() || "./profiles/outreach-worker";
  await mkdir(dir, { recursive: true });
  console.log(`Opening browser; profile dir: ${dir}`);
  console.log("Log in to Notion, then press Enter in this terminal to save and exit.\n");

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
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
