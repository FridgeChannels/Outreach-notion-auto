import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateExecuteEmailCompletion } from "../../src/flows/validators.js";
import { SESSION_STATUS } from "../../src/config.js";
import { InvalidCompletionError } from "../../src/errors.js";
import type { SessionRecord } from "../../src/notion/sessionRepository.js";

function base(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pageId: "p1",
    pageUrl: "https://www.notion.so/p1",
    sessionId: "outreach:client",
    clientPageId: "c1",
    clientPageUrl: "https://www.notion.so/c1",
    status: SESSION_STATUS.PENDING,
    nextAction: "Plan",
    conversationUrl: null,
    model: "Auto",
    nextWakeAt: "2026-08-05T12:00:00.000Z",
    lastRunAt: "2026-08-05T11:00:00.000Z",
    lastError: null,
    lastControlJson: null,
    outreachStateJson: null,
    wakeReason: null,
    wakePayloadEventId: null,
    retryCount: 0,
    clientDnc: false,
    hasLatestInteraction: false,
    lastActionId: null,
    ...overrides,
  };
}

describe("validateExecuteEmailCompletion", () => {
  it("rejects stale PLAN_COMPLETED control (empty LI false-success case)", () => {
    assert.throws(
      () =>
        validateExecuteEmailCompletion(
          base({
            lastControlJson: JSON.stringify({
              outcome: "SLEEP",
              action_performed: "PLAN_COMPLETED",
              next_action: "Execute Email",
              session_status: "Sleeping",
            }),
          }),
        ),
      InvalidCompletionError,
    );
  });

  it("rejects EMAIL_SENT without Latest Interaction", () => {
    assert.throws(
      () =>
        validateExecuteEmailCompletion(
          base({
            hasLatestInteraction: false,
            lastActionId: "live:seq:email:0:t",
            lastControlJson: JSON.stringify({
              outcome: "ACTION_COMPLETED",
              action_performed: "EMAIL_SENT",
              action_id: "live:seq:email:0:t",
              next_action: "Plan",
              session_status: "Pending",
            }),
          }),
        ),
      /Latest Interaction is empty/,
    );
  });

  it("rejects EMAIL_SENT without Last Action ID", () => {
    assert.throws(
      () =>
        validateExecuteEmailCompletion(
          base({
            hasLatestInteraction: true,
            lastActionId: null,
            lastControlJson: JSON.stringify({
              action_performed: "EMAIL_SENT",
              action_id: "live:seq:email:0:t",
            }),
          }),
        ),
      /Last Action ID is empty/,
    );
  });

  it("accepts EMAIL_SENT with LI + matching Last Action ID", () => {
    assert.doesNotThrow(() =>
      validateExecuteEmailCompletion(
        base({
          hasLatestInteraction: true,
          lastActionId: "live:seq:email:0:t",
          lastControlJson: JSON.stringify({
            action_performed: "EMAIL_SENT",
            action_id: "live:seq:email:0:t",
          }),
        }),
      ),
    );
  });

  it("accepts EMAIL_SKIPPED without Latest Interaction (intentional non-send)", () => {
    assert.doesNotThrow(() =>
      validateExecuteEmailCompletion(
        base({
          hasLatestInteraction: false,
          lastActionId: null,
          lastControlJson: JSON.stringify({
            action_performed: "EMAIL_SKIPPED",
            outcome: "PAUSED",
          }),
        }),
      ),
    );
  });

  it("rejects action_id mismatch", () => {
    assert.throws(
      () =>
        validateExecuteEmailCompletion(
          base({
            hasLatestInteraction: true,
            lastActionId: "live:other",
            lastControlJson: JSON.stringify({
              action_performed: "EMAIL_SIMULATED",
              action_id: "live:seq:email:0:t",
            }),
          }),
        ),
      /!= Control.action_id/,
    );
  });
});
