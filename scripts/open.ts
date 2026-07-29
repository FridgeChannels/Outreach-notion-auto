import "dotenv/config";
import {
  closeBrowserContext,
  configurePlaywrightTempDir,
  openBrowserContext,
} from "../src/browser.js";
import { resolveAuthStatePath } from "../src/auth.js";

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
  console.log(`Auth: ${authPath}`);
  console.log("Browser opened with saved cookies. Use Notion manually.");
  console.log("Press Enter here (or Ctrl+C) when done to close.\n");

  if (process.env.PLAYWRIGHT_HEADLESS === "true") {
    console.warn("Hint: set PLAYWRIGHT_HEADLESS=false for interactive use.");
  }

  const context = await openBrowserContext({ authPath, headless: false });
  try {
    const page = await context.newPage();
    await page.goto("https://www.notion.so", { waitUntil: "domcontentloaded", timeout: 90_000 });

    await new Promise<void>((resolve) => {
      const done = (): void => {
        process.stdin.pause();
        resolve();
      };
      process.stdin.resume();
      process.stdin.once("data", done);
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
  } finally {
    await closeBrowserContext(context);
    console.log("Browser closed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
