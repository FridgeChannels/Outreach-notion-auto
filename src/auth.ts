import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext } from "playwright";
import { NOTION_ACCOUNT, NOTION_AUTH_DIR, NOTION_AUTH_STATE_PATH } from "./config.js";
import { logger } from "./logging.js";

/** Playwright storageState shape (cookies + optional origins). */
export type CookiesOnlyState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * Resolve auth JSON path for this worker.
 * Priority: NOTION_AUTH_STATE_PATH → NOTION_AUTH_DIR/NOTION_ACCOUNT.json
 */
export function resolveAuthStatePath(accountOverride?: string): string {
  if (NOTION_AUTH_STATE_PATH) return NOTION_AUTH_STATE_PATH;
  const account = (accountOverride || NOTION_ACCOUNT || "default").trim();
  if (!account) {
    throw new Error("Set NOTION_AUTH_STATE_PATH or NOTION_ACCOUNT (+ optional NOTION_AUTH_DIR)");
  }
  // sanitize: only allow simple account folder names
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) {
    throw new Error(`Invalid NOTION_ACCOUNT name: ${account}`);
  }
  return join(NOTION_AUTH_DIR || "./auth", `${account}.json`);
}

/**
 * cookies-only read — strip origins/localStorage so Notion does not rehydrate
 * multi‑GB caches into the renderer (same approach as notion-auto dashboard).
 */
export async function loadStorageStateCookiesOnly(
  path: string,
): Promise<CookiesOnlyState | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { cookies?: unknown };
    const cookies = Array.isArray(data.cookies)
      ? (data.cookies as CookiesOnlyState["cookies"])
      : [];
    return { cookies, origins: [] };
  } catch (e) {
    logger.warn(`Failed to read auth state ${path}`, e);
    return undefined;
  }
}

export function hasUsableSavedAuth(state: CookiesOnlyState | undefined): boolean {
  return Boolean(state?.cookies?.length);
}

/** Atomic cookies-only write (no origins / localStorage). */
export async function saveStorageStateCookiesOnly(
  context: BrowserContext,
  path: string,
): Promise<void> {
  const state = await context.storageState();
  const trimmed: CookiesOnlyState = { cookies: state.cookies ?? [], origins: [] };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(trimmed), "utf-8");
  await rename(tmp, path);
}

export async function listAuthAccounts(authDir = NOTION_AUTH_DIR || "./auth"): Promise<string[]> {
  if (!existsSync(authDir)) return [];
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(authDir);
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.replace(/\.json$/i, ""))
    .sort();
}
