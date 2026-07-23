import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, BrowserContext } from "playwright";
import { ARTIFACT_DIR, PLAYWRIGHT_TRACE } from "./config.js";
import { logger } from "./logging.js";

export interface ArtifactContext {
  recordId: string;
  runId: string;
}

export async function ensureArtifactDir(): Promise<string> {
  const dir = join(process.cwd(), ARTIFACT_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function makeRunId(recordId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${recordId}_${ts}`;
}

export async function saveScreenshot(
  page: Page | null,
  ctx: ArtifactContext,
  label: string,
): Promise<string | null> {
  if (!page) return null;
  try {
    const dir = await ensureArtifactDir();
    const path = join(dir, `${ctx.runId}_${label}.png`);
    await page.screenshot({ path, fullPage: true });
    logger.info(`Screenshot saved: ${path}`);
    return path;
  } catch (e) {
    logger.warn("Failed to save screenshot", e);
    return null;
  }
}

export async function saveSnapshot(
  ctx: ArtifactContext,
  snapshot: Record<string, unknown>,
): Promise<string | null> {
  try {
    const dir = await ensureArtifactDir();
    const path = join(dir, `${ctx.runId}_snapshot.json`);
    await writeFile(path, JSON.stringify(snapshot, null, 2), "utf-8");
    return path;
  } catch (e) {
    logger.warn("Failed to save snapshot", e);
    return null;
  }
}

export async function startTracing(context: BrowserContext): Promise<void> {
  if (!PLAYWRIGHT_TRACE) return;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  } catch (e) {
    logger.warn("Failed to start tracing", e);
  }
}

export async function stopTracing(
  context: BrowserContext,
  ctx: ArtifactContext,
): Promise<string | null> {
  if (!PLAYWRIGHT_TRACE) {
    try {
      await context.tracing.stop().catch(() => undefined);
    } catch {
      // tracing may not have been started
    }
    return null;
  }
  try {
    const dir = await ensureArtifactDir();
    const path = join(dir, `${ctx.runId}_trace.zip`);
    await context.tracing.stop({ path });
    logger.info(`Trace saved: ${path}`);
    return path;
  } catch (e) {
    logger.warn("Failed to save trace", e);
    try {
      await context.tracing.stop().catch(() => undefined);
    } catch {
      // discard in-memory trace if disk write failed (e.g. ENOSPC)
    }
    return null;
  }
}
