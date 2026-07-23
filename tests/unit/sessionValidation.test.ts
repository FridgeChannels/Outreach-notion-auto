import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSuccessfulSessionUpdate, type SessionRecord } from "../../src/notion/sessionRepository.js";
import { SESSION_STATUS } from "../../src/config.js";
import { InvalidCompletionError } from "../../src/errors.js";

function base(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pageId: "p",
    pageUrl: "u",
    sessionId: "s",
    clientPageId: "c",
    clientPageUrl: "cu",
    status: SESSION_STATUS.SLEEPING,
    nextAction: "Execute Email",
    conversationUrl: "https://www.notion.so/chat",
    model: "Auto",
    nextWakeAt: "2026-07-24T00:00:00.000Z",
    lastRunAt: "2026-07-23T10:05:00.000Z",
    lastError: null,
    lastControlJson: '{"outcome":"ok"}',
    wakeReason: null,
    wakePayloadEventId: null,
    retryCount: 0,
    clientDnc: false,
    ...overrides,
  };
}

describe("validateSuccessfulSessionUpdate", () => {
  const started = new Date("2026-07-23T10:00:00.000Z");

  it("accepts Sleeping with Next Action + Next Wake At + Control JSON", () => {
    assert.doesNotThrow(() => validateSuccessfulSessionUpdate(base(), started));
  });

  it("rejects still Running", () => {
    assert.throws(
      () => validateSuccessfulSessionUpdate(base({ status: SESSION_STATUS.RUNNING }), started),
      InvalidCompletionError,
    );
  });

  it("rejects missing Last Control JSON", () => {
    assert.throws(
      () => validateSuccessfulSessionUpdate(base({ lastControlJson: null }), started),
      InvalidCompletionError,
    );
  });

  it("accepts Human Owned with Next Action None and empty wake", () => {
    assert.doesNotThrow(() =>
      validateSuccessfulSessionUpdate(
        base({
          status: SESSION_STATUS.HUMAN_OWNED,
          nextAction: "None",
          nextWakeAt: null,
        }),
        started,
      ),
    );
  });

  it("accepts Paused with Human Review and timezone Last Error", () => {
    assert.doesNotThrow(() =>
      validateSuccessfulSessionUpdate(
        base({
          status: SESSION_STATUS.PAUSED,
          nextAction: "Human Review",
          nextWakeAt: null,
          lastError: "Client Timezone required",
          wakeReason: "Client Timezone required",
        }),
        started,
      ),
    );
  });

  it("rejects Pending without Next Wake At", () => {
    assert.throws(
      () =>
        validateSuccessfulSessionUpdate(
          base({
            status: SESSION_STATUS.PENDING,
            nextAction: "Plan",
            nextWakeAt: null,
          }),
          started,
        ),
      InvalidCompletionError,
    );
  });
});
