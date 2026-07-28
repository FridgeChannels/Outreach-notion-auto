import "dotenv/config";

export const NOTION_AI_MODEL_DEFAULT = "Auto";

export const OUTREACH_CONTROLLER_PROMPT_URL =
  process.env.OUTREACH_CONTROLLER_PROMPT_URL?.trim() || "";
export const MAILBOX_REPLY_SCAN_PROMPT_URL =
  process.env.MAILBOX_REPLY_SCAN_PROMPT_URL?.trim() || "";
export const SESSION_DATA_SOURCE_URL = process.env.SESSION_DATA_SOURCE_URL?.trim() || "";
export const MAILBOX_STATE_DATA_SOURCE_URL =
  process.env.MAILBOX_STATE_DATA_SOURCE_URL?.trim() || "";

/**
 * Cookies-only Playwright storageState (preferred).
 * Multi-account: auth/<account>.json + NOTION_ACCOUNT=<account>
 * Or set NOTION_AUTH_STATE_PATH to an explicit file.
 */
export const NOTION_AUTH_DIR = process.env.NOTION_AUTH_DIR?.trim() || "./auth";
export const NOTION_ACCOUNT = process.env.NOTION_ACCOUNT?.trim() || "";
export const NOTION_AUTH_STATE_PATH = process.env.NOTION_AUTH_STATE_PATH?.trim() || "";

/** @deprecated Prefer NOTION_AUTH_* — kept only for one-shot export-from-profile. */
export const NOTION_PROFILE_DIR = process.env.NOTION_PROFILE_DIR?.trim() || "";

export const ARTIFACT_DIR = process.env.ARTIFACT_DIR?.trim() || "artifacts";
/** Full Playwright traces are ~100–200MB each. Default off; set PLAYWRIGHT_TRACE=true to enable. */
export const PLAYWRIGHT_TRACE = process.env.PLAYWRIGHT_TRACE === "true";

export const SESSION_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5 * 60 * 1000;
/** Max due Sessions claimed per poll cycle per worker (keep small when many workers). */
export const OUTREACH_BATCH_LIMIT = Math.max(
  1,
  Number(process.env.OUTREACH_BATCH_LIMIT) || 10,
);
export const CHAT_RUN_TIMEOUT_MS = 10 * 60 * 1000;
/** After chat UI looks idle, keep polling Session until it leaves Running/Claimed. */
export const SESSION_WRITEBACK_TIMEOUT_MS =
  Number(process.env.SESSION_WRITEBACK_TIMEOUT_MS) || 8 * 60 * 1000;
/** Claimed/Running older than this (or never started) are reclaimed to Pending. */
export const STALE_CLAIM_MS = Number(process.env.STALE_CLAIM_MS) || 30 * 60 * 1000;
/** Poll Notion API until Status=Running is visible to Controller before AI submit. */
export const RUNNING_VISIBILITY_TIMEOUT_MS =
  Number(process.env.RUNNING_VISIBILITY_TIMEOUT_MS) || 30_000;
/** Extra pause after Running is confirmed (API read replica lag for Controller). */
export const RUNNING_VISIBILITY_GRACE_MS =
  Number(process.env.RUNNING_VISIBILITY_GRACE_MS) || 1_000;
/** Base backoff per retry when scheduleTechnicalRetry runs (× retryCount+1 + jitter). */
export const TECHNICAL_RETRY_BACKOFF_BASE_MS =
  Number(process.env.TECHNICAL_RETRY_BACKOFF_BASE_MS) || 30_000;
/**
 * Notion AI Controller validation / gate failures — transient under multi-worker load.
 */
export const CONTROLLER_VALIDATION_ERROR_RE =
  /Controller validation failed|session_status_not_running|expected (exactly one|unique) (unarchived )?Session|Execute Email gate blocked|Route None requires Status already|No external action executed/i;
/**
 * Worker/technical Last Error messages that should be retried (not permanent Error).
 * Also used by diagnose --heal and poll reclaim watchdog.
 */
export const TECHNICAL_SESSION_ERROR_RE =
  /Session still in (Running|Claimed)|Last Run At was not updated|Last Run At is empty|Last Control JSON was not updated|Ambiguous execution|reclaimed_stale_claim|Visible Notion AI chat input not found|Running visibility not confirmed/i;
export const UI_ACTION_TIMEOUT_MS = 30 * 1000;
/** Wait for Notion AI corner / panel (servers are often slower than local). */
export const AI_PANEL_TIMEOUT_MS =
  Number(process.env.AI_PANEL_TIMEOUT_MS) || 60 * 1000;
export const MAX_TECHNICAL_RETRIES = 2;
export const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS) || 15 * 60 * 1000;
export const LOCK_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Within one poll batch, reuse the same Notion AI chat for this many successful
 * rounds, then open a New chat. Randomized per chat in [min, max].
 */
export const CHAT_REUSE_MIN_ROUNDS = Number(process.env.CHAT_REUSE_MIN_ROUNDS) || 15;
export const CHAT_REUSE_MAX_ROUNDS = Number(process.env.CHAT_REUSE_MAX_ROUNDS) || 25;

export const NOTION_API_KEY = process.env.NOTION_API_KEY?.trim() || "";
export const WORKER_ID = process.env.WORKER_ID?.trim() || `worker-${process.pid}`;
export const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== "false";

/** Session DB property names */
export const PROP = {
  SESSION_ID: "Session ID",
  CLIENT: "Client",
  STATUS: "Status",
  CONVERSATION_URL: "Conversation URL",
  MODEL: "Model",
  NEXT_WAKE_AT: "Next Wake At",
  LAST_RUN_AT: "Last Run At",
  LAST_ERROR: "Last Error",
  LAST_CONTROL_JSON: "Last Control JSON",
  RETRY_COUNT: "Retry Count",
  NEXT_ACTION: "Next Action",
  LATEST_MEETING: "Latest Meeting",
  LATEST_INTERACTION: "Latest Interaction",
  WAKE_PAYLOAD_JSON: "Wake Payload JSON",
  WAKE_REASON: "Wake Reason",
  DNC: "Email Do Not Contact",
  MEETING_CLIENT: "Client",
} as const;

/** Mailbox Sync State DB property names */
export const MAILBOX_PROP = {
  STATUS: "Status",
  CONVERSATION_URL: "Conversation URL",
  MODEL: "Model",
  NEXT_SCAN_AT: "Next Scan At",
  LAST_CHECKED_AT: "Last Checked At",
  LAST_SUCCESSFUL_AT: "Last Successful At",
  LAST_ERROR: "Last Error",
  MAILBOX: "Mailbox",
} as const;

export const SESSION_STATUS = {
  PENDING: "Pending",
  SLEEPING: "Sleeping",
  CLAIMED: "Claimed",
  RUNNING: "Running",
  HUMAN_OWNED: "Human Owned",
  CLOSED: "Closed",
  PAUSED: "Paused",
  ERROR: "Error",
} as const;

export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

export const NEXT_ACTION = {
  PLAN: "Plan",
  EXECUTE_EMAIL: "Execute Email",
  EXECUTE_LINKEDIN: "Execute LinkedIn",
  HANDLE_REPLY: "Handle Reply",
  HUMAN_REVIEW: "Human Review",
  NONE: "None",
} as const;

export type NextAction = (typeof NEXT_ACTION)[keyof typeof NEXT_ACTION];

export const MAILBOX_STATUS = {
  ACTIVE: "Active",
  SCANNING: "Scanning",
  ERROR: "Error",
  PAUSED: "Paused",
  DISABLED: "Disabled",
  NOT_STARTED: "Not started",
} as const;

export type MailboxStatus = (typeof MAILBOX_STATUS)[keyof typeof MAILBOX_STATUS];

/**
 * Extract 32-char hex page id (no hyphens).
 * app.notion.com/p/{id} REJECTS dashed UUIDs ("Oops, error loading this page").
 */
export function extractCompactPageId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const path = new URL(trimmed).pathname;
    const compact =
      path.match(/([0-9a-f]{32})/i)?.[1] ??
      path
        .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
        ?.replace(/-/g, "");
    if (compact && compact.length === 32) return compact.toLowerCase();
  } catch {
    // fall through
  }
  const bare =
    trimmed.match(/^([0-9a-f]{32})$/i)?.[1] ??
    trimmed
      .match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]
      ?.replace(/-/g, "");
  return bare && bare.length === 32 ? bare.toLowerCase() : null;
}

/**
 * Canonical page URL for @mentions in AI chat: www.notion.so + compact id (no hyphens).
 */
export function normalizeNotionPageUrl(raw: string): string {
  const compact = extractCompactPageId(raw);
  if (compact) return `https://www.notion.so/${compact}`;
  return raw.trim();
}

/**
 * Playwright goto target for opening a page / AI chat entry.
 * Must use app.notion.com/p/{compact} — dashed ids on /p/ fail to load.
 */
export function toChatEntryUrl(raw: string): string {
  const compact = extractCompactPageId(raw);
  if (compact) return `https://app.notion.com/p/${compact}`;
  return raw.trim();
}

/**
 * Dashboard-style prompt: short instruction + @page mentions (not bare multiline URLs).
 */
export function buildOutreachMessage(clientPageUrl: string): string {
  const controller = normalizeNotionPageUrl(
    process.env.OUTREACH_CONTROLLER_PROMPT_URL?.trim() || OUTREACH_CONTROLLER_PROMPT_URL,
  );
  const client = normalizeNotionPageUrl(clientPageUrl);
  return `请运行以下 Prompt： @${controller} ；执行公司： @${client}`;
}

export function buildMailboxMessage(mailboxStatePageUrl: string): string {
  const prompt = normalizeNotionPageUrl(
    process.env.MAILBOX_REPLY_SCAN_PROMPT_URL?.trim() || MAILBOX_REPLY_SCAN_PROMPT_URL,
  );
  const mailbox = normalizeNotionPageUrl(mailboxStatePageUrl);
  return `请运行以下 Prompt： @${prompt} ；执行邮箱： @${mailbox}`;
}

export function validateEnv(queues: Array<"outreach" | "mailbox"> = ["outreach", "mailbox"]): string[] {
  const missing: string[] = [];
  if (!process.env.NOTION_API_KEY?.trim()) missing.push("NOTION_API_KEY");
  const hasAuthFile = Boolean(process.env.NOTION_AUTH_STATE_PATH?.trim());
  const hasAccount = Boolean(process.env.NOTION_ACCOUNT?.trim());
  if (!hasAuthFile && !hasAccount) {
    missing.push("NOTION_ACCOUNT (or NOTION_AUTH_STATE_PATH)");
  }
  if (queues.includes("outreach")) {
    if (!process.env.OUTREACH_CONTROLLER_PROMPT_URL?.trim()) {
      missing.push("OUTREACH_CONTROLLER_PROMPT_URL");
    }
    if (!process.env.SESSION_DATA_SOURCE_URL?.trim()) missing.push("SESSION_DATA_SOURCE_URL");
  }
  if (queues.includes("mailbox")) {
    if (!process.env.MAILBOX_REPLY_SCAN_PROMPT_URL?.trim()) {
      missing.push("MAILBOX_REPLY_SCAN_PROMPT_URL");
    }
    if (!process.env.MAILBOX_STATE_DATA_SOURCE_URL?.trim()) {
      missing.push("MAILBOX_STATE_DATA_SOURCE_URL");
    }
  }
  return missing;
}
