import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LOCK_TTL_MS, WORKER_ID } from "./config.js";
import { logger } from "./logging.js";

export type LockKind = "session" | "mailbox" | "client";

interface LockRecord {
  token: string;
  key: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
}

const LOCK_DIR_NAME: Record<LockKind, string> = {
  session: "session-locks",
  mailbox: "mailbox-locks",
  client: "client-locks",
};

function lockDir(kind: LockKind): string {
  return join(process.cwd(), "data", LOCK_DIR_NAME[kind]);
}

function lockKey(kind: LockKind, id: string): string {
  return `followup:${kind}:${id}`;
}

function lockFilePath(kind: LockKind, id: string): string {
  const safe = lockKey(kind, id).replace(/[^a-zA-Z0-9:_-]/g, "_");
  return join(lockDir(kind), `${safe}.json`);
}

async function readLock(path: string): Promise<LockRecord | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8")) as LockRecord;
  } catch {
    return null;
  }
}

function isExpired(record: LockRecord): boolean {
  return Date.now() > new Date(record.expiresAt).getTime();
}

async function writeLockAtomic(path: string, record: LockRecord): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
  await rename(tmp, path);
}

/** Job-level idempotency: sessionId + wake event + nextAction. */
export function buildExecutionKey(
  sessionId: string,
  wakePayloadEventId: string | null | undefined,
  nextAction: string | null | undefined,
): string {
  return [sessionId || "", wakePayloadEventId || "none", nextAction || "none"].join(":");
}

function executionLockPath(executionKey: string): string {
  const safe = executionKey.replace(/[^a-zA-Z0-9:_-]/g, "_");
  return join(process.cwd(), "data", "execution-locks", `${safe}.json`);
}

interface ExecutionLockRecord {
  executionKey: string;
  token: string;
  workerId: string;
  submittedAt: string | null;
  conversationUrl: string | null;
  acquiredAt: string;
  expiresAt: string;
}

export async function acquireLock(kind: LockKind, id: string): Promise<string | null> {
  await mkdir(lockDir(kind), { recursive: true });
  const path = lockFilePath(kind, id);
  const existing = await readLock(path);
  if (existing && !isExpired(existing)) {
    logger.info(`Lock held by ${existing.workerId} for ${kind} ${id}`);
    return null;
  }
  const token = randomUUID();
  const now = new Date();
  const record: LockRecord = {
    token,
    key: lockKey(kind, id),
    workerId: WORKER_ID,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
  };
  await writeLockAtomic(path, record);
  const verify = await readLock(path);
  if (verify?.token !== token) return null;
  return token;
}

/** Clear locks left by a previous process with the same WORKER_ID (Ctrl+C / crash). */
export async function clearLocksOwnedByThisWorker(): Promise<number> {
  let n = 0;
  for (const kind of ["session", "mailbox", "client"] as const) {
    const dir = lockDir(kind);
    if (!existsSync(dir)) continue;
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      const record = await readLock(path);
      if (record?.workerId === WORKER_ID) {
        try {
          await unlink(path);
          n++;
          logger.warn(`Cleared stale ${kind} lock ${name} owned by ${WORKER_ID}`);
        } catch {
          // ignore
        }
      }
    }
  }
  // Also clear execution idempotency locks — otherwise a prior "submitted" mark
  // blocks re-runs after Session is reset to Pending for the same wake event.
  n += await clearExecutionLocksOwnedByThisWorker();
  return n;
}

export async function clearExecutionLocksOwnedByThisWorker(): Promise<number> {
  const dir = join(process.cwd(), "data", "execution-locks");
  if (!existsSync(dir)) return 0;
  const { readdir } = await import("node:fs/promises");
  let n = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const record = (await readLock(path)) as unknown as ExecutionLockRecord | null;
    if (record?.workerId === WORKER_ID) {
      try {
        await unlink(path);
        n++;
        logger.warn(
          `Cleared stale execution lock ${name} owned by ${WORKER_ID}` +
            (record.submittedAt ? " (was marked submitted)" : ""),
        );
      } catch {
        // ignore
      }
    }
  }
  return n;
}

/** Force-remove one execution key (e.g. technical retry of incomplete work). */
export async function clearExecutionLock(executionKey: string): Promise<void> {
  const path = executionLockPath(executionKey);
  try {
    await unlink(path);
    logger.warn(`Cleared execution lock for retry: ${executionKey}`);
  } catch {
    // ignore missing
  }
}

export async function validateLock(
  kind: LockKind,
  id: string,
  token: string,
): Promise<boolean> {
  const record = await readLock(lockFilePath(kind, id));
  if (!record || isExpired(record)) return false;
  return record.token === token;
}

/** True when a non-expired lock file exists (any worker). Used by reclaim watchdog. */
export async function isLockHeld(kind: LockKind, id: string): Promise<boolean> {
  const record = await readLock(lockFilePath(kind, id));
  return Boolean(record && !isExpired(record));
}

export async function renewLock(
  kind: LockKind,
  id: string,
  token: string,
): Promise<boolean> {
  const path = lockFilePath(kind, id);
  const record = await readLock(path);
  if (!record || record.token !== token) return false;
  record.expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  await writeLockAtomic(path, record);
  return true;
}

export async function releaseLock(
  kind: LockKind,
  id: string,
  token: string,
): Promise<void> {
  const path = lockFilePath(kind, id);
  const record = await readLock(path);
  if (record?.token === token) {
    try {
      await unlink(path);
    } catch {
      // already released
    }
  }
}

/**
 * Acquire an execution-key lock before creating chat / submitting.
 * If another worker already submitted this key, returns null.
 */
export async function acquireExecutionLock(
  executionKey: string,
): Promise<string | null> {
  await mkdir(join(process.cwd(), "data", "execution-locks"), { recursive: true });
  const path = executionLockPath(executionKey);
  const existing = (await readLock(path)) as unknown as ExecutionLockRecord | null;
  if (existing && !isExpired(existing as unknown as LockRecord)) {
    if (existing.submittedAt) {
      logger.info(`Execution already submitted: ${executionKey}`);
      return null;
    }
    logger.info(`Execution lock held for ${executionKey} by ${existing.workerId}`);
    return null;
  }
  const token = randomUUID();
  const now = new Date();
  const record: ExecutionLockRecord = {
    executionKey,
    token,
    workerId: WORKER_ID,
    submittedAt: null,
    conversationUrl: null,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LOCK_TTL_MS).toISOString(),
  };
  await writeLockAtomic(path, record as unknown as LockRecord);
  const verify = (await readLock(path)) as unknown as ExecutionLockRecord | null;
  if (verify?.token !== token) return null;
  return token;
}

export async function markExecutionSubmitted(
  executionKey: string,
  token: string,
  conversationUrl: string | null,
): Promise<void> {
  const path = executionLockPath(executionKey);
  const record = (await readLock(path)) as unknown as ExecutionLockRecord | null;
  if (!record || record.token !== token) return;
  record.submittedAt = new Date().toISOString();
  record.conversationUrl = conversationUrl;
  record.expiresAt = new Date(Date.now() + LOCK_TTL_MS).toISOString();
  await writeLockAtomic(path, record as unknown as LockRecord);
}

export async function releaseExecutionLock(
  executionKey: string,
  token: string,
  options: { onlyIfNotSubmitted?: boolean } = {},
): Promise<void> {
  const onlyIfNotSubmitted = options.onlyIfNotSubmitted !== false;
  const path = executionLockPath(executionKey);
  const record = (await readLock(path)) as unknown as ExecutionLockRecord | null;
  if (!record || record.token !== token) return;
  if (onlyIfNotSubmitted && record.submittedAt) return;
  try {
    await unlink(path);
  } catch {
    // ignore
  }
}

export function startLockHeartbeat(
  kind: LockKind,
  id: string,
  token: string,
  intervalMs: number,
): { stop: () => void } {
  const timer = setInterval(() => {
    renewLock(kind, id, token).catch((e) => logger.warn("Lock heartbeat failed", e));
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

/** Remove expired lock files (diagnose / heal). */
export async function clearExpiredLocks(kind: LockKind = "session"): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const dir = lockDir(kind);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const record = await readLock(path);
    if (!record || isExpired(record)) {
      try {
        await unlink(path);
        n++;
      } catch {
        // ignore
      }
    }
  }
  return n;
}
