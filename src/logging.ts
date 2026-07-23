import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCategory } from "./errors.js";

const LOG_DIR = join(process.cwd(), "log");
let resolvedLogFile: string | null = null;
let logFileDisabled = false;

function localDateTimeMs(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function appendToLogFile(line: string): void {
  if (logFileDisabled) return;
  try {
    if (!resolvedLogFile) {
      mkdirSync(LOG_DIR, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      resolvedLogFile = join(LOG_DIR, `worker-${date}_${process.pid}.log`);
    }
    appendFileSync(resolvedLogFile, line, "utf-8");
  } catch {
    logFileDisabled = true;
  }
}

function log(level: string, ...args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  const line = `[${localDateTimeMs()}] [outreach-worker ${level}] ${msg}\n`;
  process.stderr.write(line);
  appendToLogFile(line);
}

export interface RunLogEntry {
  kind: "outreach" | "mailbox";
  record_id: string;
  page_url: string;
  conversation_url: string | null;
  worker_id: string;
  started_at: string;
  submitted_at: string | null;
  completed_at: string | null;
  status_before: string | null;
  status_after: string | null;
  retry_count: number;
  error_category: ErrorCategory | null;
  message?: string;
}

export const logger = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    log("INFO", msg, extra ? JSON.stringify(extra) : ""),
  warn: (msg: string, err?: unknown) =>
    log("WARN", msg, err instanceof Error ? err.message : err ?? ""),
  error: (msg: string, err?: unknown) =>
    log("ERROR", msg, err instanceof Error ? err.stack ?? err.message : err ?? ""),
  run: (entry: RunLogEntry) => log("RUN", JSON.stringify(entry)),
};
