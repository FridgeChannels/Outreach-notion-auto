import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isReplyMode,
  parseSessionControlJson,
} from "../../src/notion/controlJson.js";
import { detectPlanDrift } from "../../src/notion/outreachState.js";
import {
  executionTouchKey,
  outreachExecutionKey,
  type SessionRecord,
} from "../../src/notion/sessionRepository.js";

const REPLY_CONTROL = JSON.stringify({
  communication_model: "Reply",
  reply_type: "Referral",
  reply_to_interaction_id: "mark@fridgechannels.com:19fb94ad2562848e",
  reply_execution_key:
    "reply:outreach:39e9166f-d9fd-8117-be41-e458e5550f6c:mark@fridgechannels.com:19fb94ad2562848e:Execute Email",
  reply_due_at: "2026-08-04T14:14:11.626Z",
  scheduled_touch_suppressed: true,
  next_action: "Execute Email",
  next_wake_at: "2026-08-04T14:14:11.626Z",
  session_status: "Pending",
});

const PRE_EXHIBITION_STATE = JSON.stringify({
  schema_version: "2.0",
  model_state: {
    communication_model: "Pre-Exhibition",
    next_touch_at: "2026-08-03T14:23:00.000Z",
    sequence_id: "39e9166f:email:Pre-Exhibition:t0",
    model_touch_index: 0,
  },
});

function baseSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pageId: "2c8e3c24-1814-4c1d-afd0-fdfaf7ee4c17",
    pageUrl: "https://www.notion.so/2c8e3c24-1814-4c1d-afd0-fdfaf7ee4c17",
    sessionId: "outreach:39e9166f-d9fd-8117-be41-e458e5550f6c",
    clientPageId: "39e9166f-d9fd-8117-be41-e458e5550f6c",
    clientPageUrl: "https://www.notion.so/39e9166f-d9fd-8117-be41-e458e5550f6c",
    status: "Pending",
    nextAction: "Execute Email",
    conversationUrl: null,
    model: "Auto",
    nextWakeAt: "2026-08-04T14:14:00.000Z",
    lastRunAt: "2026-08-03T14:24:00.000Z",
    lastError: null,
    lastControlJson: REPLY_CONTROL,
    outreachStateJson: PRE_EXHIBITION_STATE,
    wakeReason: "Reply requires targeted response via Reply Mode",
    wakePayloadEventId: "19fb94ad2562848e",
    retryCount: 0,
    clientDnc: false,
    hasLatestInteraction: true,
    lastActionId: null,
    ...overrides,
  };
}

describe("isReplyMode / parseSessionControlJson Reply fields", () => {
  it("detects Reply Mode from communication_model and reply_execution_key", () => {
    const parsed = parseSessionControlJson(REPLY_CONTROL);
    assert.ok(parsed);
    assert.equal(parsed!.communicationModel, "Reply");
    assert.equal(
      parsed!.replyToInteractionId,
      "mark@fridgechannels.com:19fb94ad2562848e",
    );
    assert.equal(parsed!.scheduledTouchSuppressed, true);
    assert.equal(isReplyMode(parsed), true);
  });

  it("is false for ordinary Plan control JSON", () => {
    const parsed = parseSessionControlJson(
      JSON.stringify({
        outcome: "SLEEP",
        next_action: "Execute Email",
        next_wake_at: "2026-08-05T15:00:00.000Z",
        session_status: "Sleeping",
      }),
    );
    assert.equal(isReplyMode(parsed), false);
  });
});

describe("outreachExecutionKey — Pet Honesty Reply vs Pre-Exhibition collision", () => {
  it("uses reply_execution_key instead of model_state.next_touch_at", () => {
    const session = baseSession();
    // Old bug: scheduled touch key collided with Aug 3 submitted outbound.
    assert.equal(executionTouchKey(session), "19fb94ad2562848e");
    assert.equal(
      outreachExecutionKey(session),
      "reply:outreach:39e9166f-d9fd-8117-be41-e458e5550f6c:mark@fridgechannels.com:19fb94ad2562848e:Execute Email",
    );
    assert.notEqual(
      outreachExecutionKey(session),
      "outreach:39e9166f-d9fd-8117-be41-e458e5550f6c:2026-08-03T14:23:00.000Z:Execute Email",
    );
  });

  it("falls back to reply:session:interaction:action when reply_execution_key missing", () => {
    const control = JSON.stringify({
      communication_model: "Reply",
      reply_to_interaction_id: "mark@fridgechannels.com:19fb94ad2562848e",
      scheduled_touch_suppressed: true,
      next_action: "Execute Email",
      session_status: "Pending",
      next_wake_at: "2026-08-04T14:14:00.000Z",
    });
    const key = outreachExecutionKey(
      baseSession({ lastControlJson: control, wakePayloadEventId: null }),
    );
    assert.equal(
      key,
      "reply:outreach:39e9166f-d9fd-8117-be41-e458e5550f6c:mark@fridgechannels.com:19fb94ad2562848e:Execute Email",
    );
  });

  it("keeps scheduled key when not in Reply Mode", () => {
    const session = baseSession({
      lastControlJson: JSON.stringify({
        next_action: "Execute Email",
        next_wake_at: "2026-08-03T14:23:00.000Z",
        session_status: "Sleeping",
      }),
      wakePayloadEventId: null,
      nextWakeAt: "2026-08-03T14:23:00.000Z",
    });
    assert.equal(
      outreachExecutionKey(session),
      "outreach:39e9166f-d9fd-8117-be41-e458e5550f6c:2026-08-03T14:23:00.000Z:Execute Email",
    );
  });
});

describe("detectPlanDrift — Reply Mode", () => {
  it("does not block Reply Execute Email when Pre-Exhibition next_touch_at is still future", () => {
    const futurePlan = JSON.stringify({
      model_state: { next_touch_at: "2026-08-10T14:36:00.000Z" },
    });
    assert.equal(
      detectPlanDrift(
        {
          nextAction: "Execute Email",
          nextWakeAt: "2026-08-04T14:14:00.000Z",
          outreachStateJson: futurePlan,
          lastControlJson: REPLY_CONTROL,
        },
        new Date("2026-08-04T14:15:00.000Z"),
      ),
      null,
    );
  });

  it("still blocks premature scheduled Execute Email", () => {
    assert.ok(
      detectPlanDrift(
        {
          nextAction: "Execute Email",
          nextWakeAt: "2026-08-04T14:14:00.000Z",
          outreachStateJson: JSON.stringify({
            model_state: { next_touch_at: "2026-08-10T14:36:00.000Z" },
          }),
          lastControlJson: null,
        },
        new Date("2026-08-04T14:15:00.000Z"),
      ),
    );
  });
});
