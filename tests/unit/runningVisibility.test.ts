import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SESSION_STATUS } from "../../src/config.js";
import {
  isRunningVisibilityReady,
  technicalRetryWakeAt,
  type SessionRecord,
} from "../../src/notion/sessionRepository.js";
import {
  decideErrorAction,
  isControllerValidationError,
} from "../../src/flows/validators.js";

function base(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pageId: "p1",
    pageUrl: "https://www.notion.so/p1",
    sessionId: "sess-1",
    clientPageId: "c1",
    clientPageUrl: "https://www.notion.so/c1",
    status: SESSION_STATUS.RUNNING,
    nextAction: "Execute Email",
    conversationUrl: null,
    model: "Auto",
    nextWakeAt: "2026-07-23T11:00:00.000Z",
    lastRunAt: "2026-07-23T12:00:00.000Z",
    lastError: null,
    lastControlJson: null,
    wakeReason: null,
    wakePayloadEventId: null,
    retryCount: 0,
    clientDnc: false,
    hasLatestInteraction: false,
    ...overrides,
  };
}

describe("isRunningVisibilityReady", () => {
  const startedAt = new Date("2026-07-23T12:00:00.000Z");
  const now = new Date("2026-07-23T12:00:01.000Z");
  const expected = { nextAction: "Execute Email", clientPageId: "c1" };

  it("accepts Running with matching fields and past wake", () => {
    assert.equal(isRunningVisibilityReady(base(), expected, startedAt, now), true);
  });

  it("rejects Pending (API lag)", () => {
    assert.equal(
      isRunningVisibilityReady(base({ status: SESSION_STATUS.PENDING }), expected, startedAt, now),
      false,
    );
  });

  it("rejects stale Last Run At", () => {
    assert.equal(
      isRunningVisibilityReady(
        base({ lastRunAt: "2026-07-23T10:00:00.000Z" }),
        expected,
        startedAt,
        now,
      ),
      false,
    );
  });

  it("rejects Next Action=None", () => {
    assert.equal(
      isRunningVisibilityReady(base({ nextAction: "None" }), expected, startedAt, now),
      false,
    );
  });

  it("rejects future Next Wake At", () => {
    assert.equal(
      isRunningVisibilityReady(
        base({ nextWakeAt: "2026-07-23T13:00:00.000Z" }),
        expected,
        startedAt,
        now,
      ),
      false,
    );
  });
});

describe("technicalRetryWakeAt", () => {
  it("backs off by retry count", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    const first = technicalRetryWakeAt(0, now);
    const second = technicalRetryWakeAt(1, now);
    assert.ok(first.getTime() >= now.getTime() + 30_000);
    assert.ok(second.getTime() >= now.getTime() + 60_000);
  });
});

describe("isControllerValidationError", () => {
  it("matches Controller validation failures", () => {
    assert.equal(
      isControllerValidationError(
        "Controller validation failed: expected exactly one unarchived Session with Status=Running for Client @X, but found Session Status=Pending.",
      ),
      true,
    );
    assert.equal(
      isControllerValidationError(
        "Controller precondition failed: expected the unique session for the input client to have Status=Running, but found Status=Pending; no external action executed.",
      ),
      true,
    );
    assert.equal(
      isControllerValidationError("Execute Email gate blocked: Live mode cannot run before Next Wake At."),
      true,
    );
    assert.equal(isControllerValidationError("Some unrelated business error"), false);
  });
});

describe("decideErrorAction controller errors", () => {
  it("retries post-submit Controller validation errors", () => {
    const msg =
      "Controller validation failed: expected unique Running Session for Client @Legacy Biome, but found Status=Pending.";
    assert.equal(decideErrorAction("post-submit-ambiguous", 0, true, msg), "technical-retry");
    assert.equal(decideErrorAction("post-submit-ambiguous", 2, true, msg), "mark-error");
  });

  it("retries Running visibility timeout before submit", () => {
    assert.equal(
      decideErrorAction(
        "before-submit",
        0,
        false,
        "Running visibility not confirmed within 30000ms: status=Pending",
      ),
      "technical-retry",
    );
  });
});
