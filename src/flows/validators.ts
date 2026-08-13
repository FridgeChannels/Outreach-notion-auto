import {
  CONTROLLER_VALIDATION_ERROR_RE,
  MAX_TECHNICAL_RETRIES,
  SESSION_STATUS,
  TECHNICAL_SESSION_ERROR_RE,
  type SessionStatus,
} from "../config.js";
import { InvalidCompletionError, SkipError, type ExecutionPhase } from "../errors.js";
import type { SessionRecord } from "../notion/sessionRepository.js";
import type { MailboxRecord } from "../notion/mailboxRepository.js";
import { MAILBOX_STATUS } from "../config.js";
import {
  EXECUTE_EMAIL_TERMINAL_ACTIONS,
  isExecuteEmailSentAction,
  parseSessionControlJson,
} from "../notion/controlJson.js";

export function validateSessionBeforeBrowser(session: SessionRecord): void {
  if (!session.sessionId?.trim()) throw new SkipError("Session ID is empty");
  if (!session.clientPageId || !session.clientPageUrl) {
    throw new SkipError("Client relation is empty");
  }
  if (session.status !== SESSION_STATUS.CLAIMED) {
    throw new SkipError(`Status is ${session.status}, expected Claimed`);
  }
  if (session.clientDnc) throw new SkipError("Client Email Do Not Contact is true");
}

export function validateSessionBeforeSubmit(
  session: SessionRecord,
  expectedClientPageId: string | null,
): void {
  if (session.status !== SESSION_STATUS.CLAIMED) {
    throw new SkipError(`Status changed to ${session.status} before submit`);
  }
  if (session.clientPageId !== expectedClientPageId) {
    throw new SkipError("Client relation changed before submit");
  }
  if (session.clientDnc) throw new SkipError("DNC enabled before submit");
}

export function validateMailboxBeforeBrowser(mailbox: MailboxRecord): void {
  if (
    mailbox.status === MAILBOX_STATUS.PAUSED ||
    mailbox.status === MAILBOX_STATUS.DISABLED
  ) {
    throw new SkipError(`Mailbox is ${mailbox.status}`);
  }
}

/**
 * Execute Email Stage 9 contract (mirrors Controller Prompt).
 * Called only when the claimed Next Action was Execute Email.
 * Sent/simulated require Latest Interaction + Last Action ID; otherwise
 * InvalidCompletionError so we technical-retry and do NOT mark submitted.
 */
export function validateExecuteEmailCompletion(session: SessionRecord): void {
  const control = parseSessionControlJson(session.lastControlJson);
  const performed = control?.actionPerformed?.trim() || null;
  if (!performed || !EXECUTE_EMAIL_TERMINAL_ACTIONS.has(performed)) {
    throw new InvalidCompletionError(
      `Execute Email writeback missing terminal action_performed (got ${performed ?? "null"}); ` +
        `refusing to mark touch submitted without EMAIL_SENT/SIMULATED/SKIPPED/FAILED`,
    );
  }
  if (!isExecuteEmailSentAction(performed)) return;

  if (!session.hasLatestInteraction) {
    throw new InvalidCompletionError(
      `Execute Email ${performed} but Latest Interaction is empty; Prompt Stage 9 incomplete`,
    );
  }
  if (!session.lastActionId?.trim()) {
    throw new InvalidCompletionError(
      `Execute Email ${performed} but Last Action ID is empty; Prompt Stage 9 incomplete`,
    );
  }
  if (control?.actionId && session.lastActionId.trim() !== control.actionId.trim()) {
    throw new InvalidCompletionError(
      `Execute Email Last Action ID (${session.lastActionId}) != Control.action_id (${control.actionId})`,
    );
  }
}

/**
 * A completed Plan must advance the state machine. Retaining Next Action=Plan
 * would let a submitted Plan mark suppress every future attempt for this touch.
 */
export function validatePlanCompletion(session: SessionRecord): void {
  if (session.nextAction === "Plan") {
    throw new InvalidCompletionError(
      "Plan writeback retained Next Action=Plan; refusing to mark Plan submitted",
    );
  }
}

export function isSchedulerEligible(
  status: string | null,
  nextAction: string | null,
  nextWakeAt: string | null,
  now = new Date(),
): boolean {
  if (!status || !nextWakeAt) return false;
  if (status !== SESSION_STATUS.PENDING && status !== SESSION_STATUS.SLEEPING) return false;
  if (!nextAction || nextAction === "None" || nextAction === "Human Review") return false;
  return new Date(nextWakeAt).getTime() <= now.getTime();
}

export type ErrorAction = "skip" | "technical-retry" | "mark-error";

/** Flaky Notion AI UI — never permanent Error; allow Pending retry. */
export function isTransientUiError(message: string): boolean {
  return /Visible Notion AI chat input not found|AI panel not found|chat input not visible|composer|Something went wrong|dismiss the error|rate limit/i.test(
    message,
  );
}

/** Incomplete writeback / InvalidCompletion — retry unless retries exhausted. */
export function isTechnicalWritebackError(message: string): boolean {
  return TECHNICAL_SESSION_ERROR_RE.test(message);
}

/** Controller read stale Session state or gate blocked — retry with backoff. */
export function isControllerValidationError(message: string): boolean {
  return CONTROLLER_VALIDATION_ERROR_RE.test(message);
}

export function decideErrorAction(
  phase: ExecutionPhase,
  retryCount: number,
  submitted: boolean,
  errorMessage = "",
): ErrorAction {
  if (phase === "skip") return "skip";
  if (retryCount >= MAX_TECHNICAL_RETRIES) return "mark-error";

  // Missing composer after AI finishes / between batch jobs — keep retryable
  if (isTransientUiError(errorMessage)) return "technical-retry";

  // Controller validation / gate failures after AI submit
  if (submitted && isControllerValidationError(errorMessage)) return "technical-retry";

  // Partial Notion AI writeback (Status stuck Running, etc.)
  if (
    phase === "invalid-completion" ||
    isTechnicalWritebackError(errorMessage) ||
    isControllerValidationError(errorMessage)
  ) {
    return "technical-retry";
  }

  if (phase === "before-submit" && !submitted) return "technical-retry";
  if (phase === "conversation" && !submitted) return "technical-retry";
  return "mark-error";
}

/** Reject prompt-page / new-chat stub URLs as Conversation URL. */
export function knownPromptUrls(urls: string[]): string[] {
  return urls.map((u) => u.trim()).filter(Boolean);
}

/**
 * Notion Agent durable thread id in `?t=…` (not `t=new`).
 * Observed form: 32-char hex on app.notion.com/p/{Prompt}?t={thread}.
 */
export function isDurableAgentThreadParam(t: string | null | undefined): boolean {
  if (!t) return false;
  const v = t.trim();
  if (!v || v.toLowerCase() === "new") return false;
  if (/^[0-9a-f]{20,}$/i.test(v)) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function isRealConversationUrl(url: string, knownPromptUrlsList: string[] = []): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "www.notion.so" && host !== "notion.so" && host !== "app.notion.com") {
      return false;
    }
    // Network capture previously saved API endpoints as Conversation URL
    if (u.pathname.includes("/api/") || u.pathname.startsWith("/api")) return false;
    if (u.pathname.includes("/_assets/")) return false;
    if (u.searchParams.get("t") === "new") return false;
    if (/\/new(?:\/|$)/i.test(u.pathname)) return false;

    // Current Notion Agent UI: conversation stays on the Prompt /p/ page with ?t=<threadId>
    if (isDurableAgentThreadParam(u.searchParams.get("t"))) {
      return true;
    }

    for (const prompt of knownPromptUrlsList) {
      try {
        const p = new URL(prompt);
        if (u.origin === p.origin && u.pathname === p.pathname) return false;
        // Compact id in prompt path should also match dashed page forms
        const promptId = p.pathname.match(/([0-9a-f]{32})/i)?.[1]?.toLowerCase();
        const urlId =
          u.pathname.match(/([0-9a-f]{32})/i)?.[1]?.toLowerCase() ??
          u.pathname
            .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
            ?.replace(/-/g, "")
            .toLowerCase();
        if (promptId && urlId && promptId === urlId) return false;
      } catch {
        // ignore
      }
    }

    // Legacy / alternate durable chat routes
    return (
      /\/chat\//i.test(u.pathname) ||
      u.searchParams.has("threadId") ||
      u.searchParams.has("chatId") ||
      u.searchParams.has("agentChatId")
    );
  } catch {
    return false;
  }
}

/** Alias used by conversation wait/verify helpers. */
export const isValidConversationUrl = isRealConversationUrl;

export function assertChatTemplate(
  message: string,
  promptUrl: string,
  targetUrl: string,
  promptLabel: string,
  targetLabel: string,
): boolean {
  const lines = message.split("\n");
  return (
    lines[0] === `请运行以下 Prompt：` &&
    lines[1] === promptUrl &&
    lines[2] === "" &&
    lines[3] === targetLabel &&
    lines[4] === targetUrl &&
    lines.length === 5 &&
    promptLabel.length >= 0
  );
}

export type { SessionStatus };
