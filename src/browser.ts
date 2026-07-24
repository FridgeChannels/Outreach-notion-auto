import { mkdir, mkdtemp, rm, access, constants, unlink, statfs, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { HEADLESS, NOTION_PROFILE_DIR } from "./config.js";
import { logger } from "./logging.js";

const MIN_FREE_BYTES = 512 * 1024 * 1024; // 512MB
const LAUNCH_ATTEMPTS = 4;

/** Project-local temp — never rely on system /tmp (Docker + macOS APFS EIO). */
export function playwrightTempRoot(): string {
  return join(process.cwd(), ".playwright-tmp");
}

/**
 * Force Node + Playwright temp dirs onto the project volume before any launch.
 * Also set env early so any remaining os.tmpdir() callers stay on-project.
 */
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

/** Remove Chromium profile locks left by crashed workers (same profile, new launch). */
export async function clearStaleProfileLocks(profileDir: string): Promise<void> {
  if (!profileDir || !existsSync(profileDir)) return;
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]) {
    const p = join(profileDir, name);
    try {
      await unlink(p);
      logger.warn(`Removed stale Chromium lock: ${p}`);
    } catch {
      // ignore missing
    }
  }
}

/**
 * Explicit artifacts dir — Playwright skips mkdtemp('/tmp/playwright-artifacts-*')
 * when options.artifactsDir is set (see playwright-core _prepareToLaunch).
 */
async function createArtifactsDir(): Promise<string> {
  const root = await configurePlaywrightTempDir();
  return mkdtemp(join(root, "playwright-artifacts-"));
}

/** Best-effort cleanup of old artifact folders (keep last few). */
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

export async function openPersistentBrowserContext(): Promise<BrowserContext> {
  if (!NOTION_PROFILE_DIR) {
    throw new Error("NOTION_PROFILE_DIR is not configured");
  }

  await configurePlaywrightTempDir();
  await assertDiskSpaceForBrowser();
  await mkdir(NOTION_PROFILE_DIR, { recursive: true });
  await pruneOldArtifactDirs();

  let last: unknown;
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    let artifactsDir: string | null = null;
    try {
      await clearStaleProfileLocks(NOTION_PROFILE_DIR);
      artifactsDir = await createArtifactsDir();
      const context = await chromium.launchPersistentContext(NOTION_PROFILE_DIR, {
        headless: HEADLESS,
        viewport: { width: 1440, height: 1000 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        // Critical: bypass system /tmp mkdtemp entirely
        artifactsDir,
        args: [
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-software-rasterizer",
        ],
      });
      if (attempt > 1) logger.info(`Browser launch succeeded on attempt ${attempt}`);
      logger.info("Browser launched", {
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

export async function preflightBrowserEnvironment(): Promise<void> {
  await configurePlaywrightTempDir();
  await assertDiskSpaceForBrowser();
  if (NOTION_PROFILE_DIR) {
    await mkdir(NOTION_PROFILE_DIR, { recursive: true });
    await access(NOTION_PROFILE_DIR, constants.R_OK | constants.W_OK);
  }
  // Prove we can create the exact prefix Playwright would use — on project volume
  const probe = await createArtifactsDir();
  await rm(probe, { recursive: true, force: true });
  const free = await freeBytesForPath(playwrightTempRoot());
  logger.info("Browser preflight OK", {
    tmpdir: process.env.TMPDIR,
    profile: NOTION_PROFILE_DIR,
    freeMb: free != null ? Math.round(free / 1e6) : null,
  });
}
