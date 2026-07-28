import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isReconcileableControlJson,
  isStaleClaimOrRunning,
  parseSessionControlJson,
} from "../../src/notion/controlJson.js";
import { SESSION_STATUS } from "../../src/config.js";

describe("parseSessionControlJson", () => {
  it("parses SLEEP / PLAN_COMPLETED control block", () => {
    const raw = JSON.stringify({
      outcome: "SLEEP",
      action_performed: "PLAN_COMPLETED",
      next_action: "Execute Email",
      next_wake_at: "2026-07-27T16:30:00.000Z",
      session_status: "Sleeping",
    });
    const parsed = parseSessionControlJson(raw);
    assert.ok(parsed);
    assert.equal(parsed!.sessionStatus, SESSION_STATUS.SLEEPING);
    assert.equal(parsed!.nextAction, "Execute Email");
    assert.equal(parsed!.nextWakeAt, "2026-07-27T16:30:00.000Z");
    assert.equal(isReconcileableControlJson(parsed), true);
  });

  it("rejects control that still says Running", () => {
    const parsed = parseSessionControlJson(
      JSON.stringify({
        session_status: "Running",
        next_action: "Plan",
        next_wake_at: "2026-07-27T16:30:00.000Z",
      }),
    );
    assert.equal(isReconcileableControlJson(parsed), false);
  });

  it("rejects Sleeping without wake", () => {
    const parsed = parseSessionControlJson(
      JSON.stringify({
        session_status: "Sleeping",
        next_action: "Execute Email",
      }),
    );
    assert.equal(isReconcileableControlJson(parsed), false);
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseSessionControlJson("not-json"), null);
  });
});

describe("isStaleClaimOrRunning", () => {
  const now = Date.parse("2026-07-28T02:00:00.000Z");
  const staleMs = 30 * 60 * 1000;

  it("treats Claimed with empty Last Run At as stale", () => {
    assert.equal(isStaleClaimOrRunning(SESSION_STATUS.CLAIMED, null, now, staleMs), true);
  });

  it("keeps fresh Running within TTL", () => {
    assert.equal(
      isStaleClaimOrRunning(
        SESSION_STATUS.RUNNING,
        "2026-07-28T01:45:00.000Z",
        now,
        staleMs,
      ),
      false,
    );
  });

  it("flags old Running as stale", () => {
    assert.equal(
      isStaleClaimOrRunning(
        SESSION_STATUS.RUNNING,
        "2026-07-28T01:00:00.000Z",
        now,
        staleMs,
      ),
      true,
    );
  });

  it("ignores Pending", () => {
    assert.equal(isStaleClaimOrRunning(SESSION_STATUS.PENDING, null, now, staleMs), false);
  });
});
