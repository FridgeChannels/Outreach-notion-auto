/**
 * One-shot: export cookies-only storageState from an old Chromium profile dir.
 * Usage:
 *   NOTION_PROFILE_DIR=./profiles/outreach-worker npm run worker:export-auth -- --account=mark
 */
import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { resolveAuthStatePath, saveStorageStateCookiesOnly } from "../src/auth.js";
import { configurePlaywrightTempDir } from "../src/browser.js";
import { NOTION_PROFILE_DIR } from "../src/config.js";

function parseAccount(args: string[]): string {
  const flag = args.find((a) => a.startsWith("--account="));
  if (flag) return flag.slice("--account=".length).trim();
  const idx = args.indexOf("--account");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1].trim();
  return process.env.NOTION_ACCOUNT?.trim() || "default";
}

async function main(): Promise<void> {
  const profile = NOTION_PROFILE_DIR;
  if (!profile) {
    throw new Error("Set NOTION_PROFILE_DIR to the existing Chromium profile to export from");
  }
  const account = parseAccount(process.argv.slice(2));
  const authPath = resolveAuthStatePath(account);

  await configurePlaywrightTempDir();
  await mkdir(profile, { recursive: true });

  console.log(`Opening profile: ${profile}`);
  console.log(`Exporting cookies → ${authPath}`);

  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    const page = await context.newPage();
    await page.goto("https://www.notion.so", { waitUntil: "domcontentloaded", timeout: 90_000 });
    await saveStorageStateCookiesOnly(context, authPath);
    console.log(`Done. You can stop using profiles and set NOTION_ACCOUNT=${account}`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
