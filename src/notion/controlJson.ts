import { NEXT_ACTION, SESSION_STATUS, type NextAction, type SessionStatus } from "../config.js";

export interface ParsedControlJson {
  outcome: string | null;
  sessionStatus: SessionStatus | null;
  nextAction: NextAction | null;
  nextWakeAt: string | null;
  /** Reply Mode fields — written by Handle Reply / Controller. */
  communicationModel: string | null;
  replyToInteractionId: string | null;
  replyExecutionKey: string | null;
  scheduledTouchSuppressed: boolean;
}

const SESSION_STATUS_VALUES = new Set<string>(Object.values(SESSION_STATUS));
const NEXT_ACTION_VALUES = new Set<string>(Object.values(NEXT_ACTION));

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Parse Last Control JSON written by Notion AI Prompt.
 * Tolerates minor key aliases used across prompt versions.
 */
export function parseSessionControlJson(raw: string | null | undefined): ParsedControlJson | null {
  if (!raw?.trim()) return null;
  let text = raw.trim();
  // Notion rich text occasionally double-encodes
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    try {
      text = JSON.parse(text) as string;
    } catch {
      // keep original
    }
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }

  const statusRaw =
    asString(obj.session_status) ||
    asString(obj.sessionStatus) ||
    asString(obj.status);
  const actionRaw =
    asString(obj.next_action) ||
    asString(obj.nextAction);
  const wakeRaw =
    asString(obj.next_wake_at) ||
    asString(obj.nextWakeAt);

  const sessionStatus =
    statusRaw && SESSION_STATUS_VALUES.has(statusRaw)
      ? (statusRaw as SessionStatus)
      : null;
  const nextAction =
    actionRaw && NEXT_ACTION_VALUES.has(actionRaw) ? (actionRaw as NextAction) : null;

  const scheduledSuppressed =
    obj.scheduled_touch_suppressed === true ||
    obj.scheduledTouchSuppressed === true;

  return {
    outcome: asString(obj.outcome),
    sessionStatus,
    nextAction,
    nextWakeAt: wakeRaw,
    communicationModel:
      asString(obj.communication_model) || asString(obj.communicationModel),
    replyToInteractionId:
      asString(obj.reply_to_interaction_id) ||
      asString(obj.replyToInteractionId),
    replyExecutionKey:
      asString(obj.reply_execution_key) || asString(obj.replyExecutionKey),
    scheduledTouchSuppressed: scheduledSuppressed,
  };
}

/**
 * True when Last Control JSON says this Session is in Reply Mode.
 * Scheduled Outreach State JSON (Pre-Exhibition next_touch_at, etc.) must not
 * drive dedupe keys or plan-drift gates while Reply is active.
 */
export function isReplyMode(control: ParsedControlJson | null | undefined): boolean {
  if (!control) return false;
  if (control.communicationModel === "Reply") return true;
  if (control.scheduledTouchSuppressed) return true;
  if (control.replyToInteractionId || control.replyExecutionKey) return true;
  return false;
}

/** Control JSON is complete enough to reconcile a stuck Running/Claimed Session. */
export function isReconcileableControlJson(parsed: ParsedControlJson | null): boolean {
  if (!parsed?.sessionStatus) return false;
  if (
    parsed.sessionStatus === SESSION_STATUS.CLAIMED ||
    parsed.sessionStatus === SESSION_STATUS.RUNNING
  ) {
    return false;
  }

  switch (parsed.sessionStatus) {
    case SESSION_STATUS.SLEEPING:
    case SESSION_STATUS.PENDING:
      return Boolean(
        parsed.nextAction &&
          parsed.nextAction !== NEXT_ACTION.NONE &&
          parsed.nextWakeAt,
      );
    case SESSION_STATUS.CLOSED:
    case SESSION_STATUS.HUMAN_OWNED:
      return !parsed.nextAction || parsed.nextAction === NEXT_ACTION.NONE;
    case SESSION_STATUS.PAUSED:
      return true;
    case SESSION_STATUS.ERROR:
      return true;
    default:
      return false;
  }
}

/**
 * Claimed/Running is stale when never started, or last run older than ttl.
 * Active jobs (fresh Last Run At) are left alone.
 */
export function isStaleClaimOrRunning(
  status: string | null,
  lastRunAt: string | null,
  nowMs: number,
  staleMs: number,
): boolean {
  if (status !== SESSION_STATUS.CLAIMED && status !== SESSION_STATUS.RUNNING) {
    return false;
  }
  if (!lastRunAt) return true;
  const runMs = new Date(lastRunAt).getTime();
  if (Number.isNaN(runMs)) return true;
  return nowMs - runMs >= staleMs;
}
