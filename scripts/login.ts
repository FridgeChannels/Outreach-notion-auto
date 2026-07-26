import "dotenv/config";
import {
  closeBrowserContext,
  configurePlaywrightTempDir,
  openLoginBrowserContext,
} from "../src/browser.js";
import { resolveAuthStatePath, saveStorageStateCookiesOnly } from "../src/auth.js";

function parseAccount(args: string[]): string {
  const flag = args.find((a) => a.startsWith("--account="));
  if (flag) return flag.slice("--account=".length).trim();
  const idx = args.indexOf("--account");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1].trim();
  return process.env.NOTION_ACCOUNT?.trim() || "default";
}

async function main(): Promise<void> {
  const account = parseAccount(process.argv.slice(2));
  const authPath = resolveAuthStatePath(account);

  await configurePlaywrightTempDir();
  console.log(`Account: ${account}`);
  console.log(`Will save cookies-only storageState → ${authPath}`);
  console.log("Log in to Notion in the browser, then press Enter here to save.\n");

  if (process.env.PLAYWRIGHT_HEADLESS === "true") {
    console.warn("Hint: set PLAYWRIGHT_HEADLESS=false for interactive login.");
  }

  const context = await openLoginBrowserContext(false);
  try {
    const page = await context.newPage();
    await page.goto("https://www.notion.so", { waitUntil: "domcontentloaded", timeout: 90_000 });

    await new Promise<void>((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });

    await saveStorageStateCookiesOnly(context, authPath);
    console.log(`Saved cookies-only auth → ${authPath}`);
    console.log("Upload this small JSON to the server/S3 (not the profiles/ directory).");
  } finally {
    await closeBrowserContext(context);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
