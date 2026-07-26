import { mkdir, mkdtemp, rm, access, constants, statfs, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  hasUsableSavedAuth,
  loadStorageStateCookiesOnly,
  resolveAuthStatePath,
  type CookiesOnlyState,
} from "./auth.js";
import { HEADLESS } from "./config.js";
import { logger } from "./logging.js";

const MIN_FREE_BYTES = 512 * 1024 * 1024; // 512MB
const LAUNCH_ATTEMPTS = 4;

const browsersByContext = new WeakMap<BrowserContext, Browser>();

const CHROMIUM_ARGS = [
  "--disable-dev-shm-usage",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
];

/** Project-local temp — never rely on system /tmp (Docker + macOS APFS EIO). */
export function playwrightTempRoot(): string {
  return join(process.cwd(), ".playwright-tmp");
}

export async function configurePlaywrightTempDir(): Promise<string> {
  const root = playwrightTempRoot();
  await mkdir(root, { recursive: true });
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  const probe = await mkdtemp(join(root, "probe-"));
  await rm(probe, { recursive: true, force: true });
  return root;
}

async function freeBytesForPath(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function assertDiskSpaceForBrowser(): Promise<void> {
  const root = playwrightTempRoot();
  const free = (await freeBytesForPath(root)) ?? (await freeBytesForPath("/"));
  if (free != null && free < MIN_FREE_BYTES) {
    throw new Error(
      `Insufficient disk space for Playwright (~${Math.round(free / 1e6)}MB free, need ≥512MB). Free space then retry.`,
    );
  }
}

async function createArtifactsDir(): Promise<string> {
  const root = await configurePlaywrightTempDir();
  return mkdtemp(join(root, "playwright-artifacts-"));
}

async function pruneOldArtifactDirs(keep = 3): Promise<void> {
  const root = playwrightTempRoot();
  if (!existsSync(root)) return;
  try {
    const names = (await readdir(root))
      .filter((n) => n.startsWith("playwright-artifacts-"))
      .sort();
    const drop = names.slice(0, Math.max(0, names.length - keep));
    for (const n of drop) {
      await rm(join(root, n), { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // ignore
  }
}

function isTransientLaunchError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /EIO|ENOSPC|EBUSY|EAGAIN|mkdtemp|Target closed|browser has been closed|Failed to launch/i.test(
    msg,
  );
}

/**
 * Launch Chromium + inject cookies-only storageState (multi-account safe).
 * Each account = one JSON file; many workers can run in parallel with different files.
 */
export async function openBrowserContext(options?: {
  authPath?: string;
  storageState?: CookiesOnlyState;
  headless?: boolean;
}): Promise<BrowserContext> {
  await configurePlaywrightTempDir();
  await assertDiskSpaceForBrowser();
  await pruneOldArtifactDirs();

  const authPath = options?.authPath ?? resolveAuthStatePath();
  const storageState =
    options?.storageState ?? (await loadStorageStateCookiesOnly(authPath));
  if (!hasUsableSavedAuth(storageState)) {
    throw new Error(
      `No usable Notion auth cookies at ${authPath}. Run: npm run worker:login -- --account=<name>`,
    );
  }

  const headless = options?.headless ?? HEADLESS;
  let last: unknown;

  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    let artifactsDir: string | null = null;
    try {
      artifactsDir = await createArtifactsDir();
      const browser = await chromium.launch({
        headless,
        args: CHROMIUM_ARGS,
        // downloads/traces under project temp — avoid /tmp mkdtemp EIO
        tracesDir: artifactsDir,
      });
      const context = await browser.newContext({
        storageState,
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
      browsersByContext.set(context, browser);
      if (attempt > 1) logger.info(`Browser launch succeeded on attempt ${attempt}`);
      logger.info("Browser launched (storageState)", {
        authPath,
        cookieCount: storageState?.cookies?.length ?? 0,
        artifactsDir,
        tmpdir: process.env.TMPDIR,
      });
      return context;
    } catch (e) {
      last = e;
      if (artifactsDir) {
        await rm(artifactsDir, { recursive: true, force: true }).catch(() => undefined);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (!isTransientLaunchError(e) || attempt === LAUNCH_ATTEMPTS) throw e;
      const waitMs = Math.min(8_000, 500 * 2 ** (attempt - 1));
      logger.warn(
        `Browser launch failed (attempt ${attempt}/${LAUNCH_ATTEMPTS}): ${msg.slice(0, 200)}; retry in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

/** @deprecated Use openBrowserContext — kept for call-site compatibility. */
export const openPersistentBrowserContext = openBrowserContext;

/** Close context and underlying browser (storageState mode owns the Browser). */
export async function closeBrowserContext(context: BrowserContext): Promise<void> {
  const browser = browsersByContext.get(context);
  await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
}

/**
 * Fresh headed browser with no cookies — for interactive login / export.
 * Caller must closeBrowserContext when done.
 */
export async function openLoginBrowserContext(headless = false): Promise<BrowserContext> {
  await configurePlaywrightTempDir();
  await assertDiskSpaceForBrowser();
  const artifactsDir = await createArtifactsDir();
  const browser = await chromium.launch({
    headless,
    args: CHROMIUM_ARGS,
    tracesDir: artifactsDir,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  browsersByContext.set(context, browser);
  return context;
}

export async function preflightBrowserEnvironment(): Promise<void> {
  await configurePlaywrightTempDir();
  await assertDiskSpaceForBrowser();
  const authPath = resolveAuthStatePath();
  const state = await loadStorageStateCookiesOnly(authPath);
  if (!hasUsableSavedAuth(state)) {
    throw new Error(
      `Auth preflight failed: missing cookies at ${authPath}. Run worker:login first.`,
    );
  }
  try {
    await access(authPath, constants.R_OK);
  } catch {
    throw new Error(`Auth file not readable: ${authPath}`);
  }
  const probe = await createArtifactsDir();
  await rm(probe, { recursive: true, force: true });
  const free = await freeBytesForPath(playwrightTempRoot());
  logger.info("Browser preflight OK", {
    tmpdir: process.env.TMPDIR,
    authPath,
    cookieCount: state?.cookies?.length ?? 0,
    freeMb: free != null ? Math.round(free / 1e6) : null,
  });
}
