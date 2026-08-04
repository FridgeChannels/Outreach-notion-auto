import { NEXT_ACTION, PLAN_DRIFT_TOLERANCE_MS, type NextAction } from "../config.js";
import { isReplyMode, parseSessionControlJson } from "./controlJson.js";

export interface ParsedOutreachState {
  nextTouchAt: string | null;
  sequenceId: string | null;
  modelTouchIndex: number | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Parse Outreach State JSON written by the Plan stage of the Controller Prompt.
 * `model_state.next_touch_at` is the business source of truth for when the next
 * outbound touch may be sent; Session.Next Wake At only mirrors it.
 */
export function parseOutreachStateJson(
  raw: string | null | undefined,
): ParsedOutreachState | null {
  if (!raw?.trim()) return null;
  let text = raw.trim();
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
  const modelState = asRecord(obj.model_state) ?? asRecord(obj.modelState) ?? obj;
  const touchIndexRaw = modelState.model_touch_index ?? modelState.modelTouchIndex;
  return {
    nextTouchAt:
      asString(modelState.next_touch_at) ?? asString(modelState.nextTouchAt),
    sequenceId: asString(modelState.sequence_id) ?? asString(modelState.sequenceId),
    modelTouchIndex: typeof touchIndexRaw === "number" ? touchIndexRaw : null,
  };
}

/** Only these actions send external outbound messages and need the due-time gate. */
export function isOutboundAction(nextAction: string | null | undefined): boolean {
  return (
    nextAction === NEXT_ACTION.EXECUTE_EMAIL ||
    nextAction === NEXT_ACTION.EXECUTE_LINKEDIN
  );
}

export interface PlanDrift {
  /** model_state.next_touch_at — the planned outbound time. */
  plannedAt: string;
  /** Session.Next Wake At the scheduler acted on. */
  wakeAt: string | null;
  /** plannedAt - wakeAt, in ms. */
  driftMs: number;
  nextAction: NextAction | string;
}

export interface PlanDriftInput {
  nextAction: string | null;
  nextWakeAt: string | null;
  outreachStateJson: string | null;
  /** When set, Reply Mode skips the scheduled-touch drift gate. */
  lastControlJson?: string | null;
}

/**
 * Detect a Session whose Next Wake At no longer matches the planned outbound
 * time. This happens when a technical path rewrites Next Wake At (retry backoff,
 * stale-claim reclaim) on a row whose plan points days ahead: the row then looks
 * "due" forever and an Execute run would send the next touch far too early.
 *
 * Returns null when the row is consistent, not an outbound action, or has no plan.
 * Reply Mode also returns null: inbound replies use Session.Next Wake At and must
 * not be blocked by a stale Pre-Exhibition model_state.next_touch_at.
 */
export function detectPlanDrift(
  session: PlanDriftInput,
  now = new Date(),
  toleranceMs = PLAN_DRIFT_TOLERANCE_MS,
): PlanDrift | null {
  if (!isOutboundAction(session.nextAction)) return null;
  if (isReplyMode(parseSessionControlJson(session.lastControlJson))) return null;
  const state = parseOutreachStateJson(session.outreachStateJson);
  if (!state?.nextTouchAt) return null;

  const plannedMs = new Date(state.nextTouchAt).getTime();
  if (Number.isNaN(plannedMs)) return null;
  // A plan in the past cannot cause a premature send.
  if (plannedMs <= now.getTime() + toleranceMs) return null;

  const wakeMs = session.nextWakeAt ? new Date(session.nextWakeAt).getTime() : NaN;
  // Wake At missing or earlier than the plan ⇒ scheduler would fire too early.
  if (!Number.isNaN(wakeMs) && plannedMs - wakeMs <= toleranceMs) return null;

  return {
    plannedAt: state.nextTouchAt,
    wakeAt: session.nextWakeAt,
    driftMs: Number.isNaN(wakeMs) ? plannedMs - now.getTime() : plannedMs - wakeMs,
    nextAction: session.nextAction!,
  };
}

export function describePlanDrift(drift: PlanDrift): string {
  return (
    `Plan drift: Next Wake At=${drift.wakeAt ?? "empty"} but Outreach State JSON ` +
    `model_state.next_touch_at=${drift.plannedAt} (${Math.round(drift.driftMs / 60_000)}min later); ` +
    `${drift.nextAction} withheld to avoid premature outbound`
  );
}
