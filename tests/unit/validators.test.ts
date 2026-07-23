import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideErrorAction,
  isSchedulerEligible,
  isRealConversationUrl,
  validateSessionBeforeBrowser,
  validateSessionBeforeSubmit,
} from "../../src/flows/validators.js";
import { SESSION_STATUS } from "../../src/config.js";
import { SkipError } from "../../src/errors.js";
import type { SessionRecord } from "../../src/notion/sessionRepository.js";

function base(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    pageId: "p1",
    pageUrl: "https://www.notion.so/p1",
    sessionId: "sess-1",
    clientPageId: "c1",
    clientPageUrl: "https://www.notion.so/c1",
    status: SESSION_STATUS.CLAIMED,
    nextAction: "Plan",
    conversationUrl: null,
    model: "Auto",
    nextWakeAt: null,
    lastRunAt: null,
    lastError: null,
    lastControlJson: null,
    wakeReason: null,
    wakePayloadEventId: null,
    retryCount: 0,
    clientDnc: false,
    ...overrides,
  };
}

describe("isSchedulerEligible", () => {
  const now = new Date("2026-07-23T12:00:00.000Z");

  it("includes Pending/Sleeping with actionable Next Action and past wake", () => {
    assert.equal(
      isSchedulerEligible(SESSION_STATUS.PENDING, "Plan", "2026-07-23T11:00:00.000Z", now),
      true,
    );
    assert.equal(
      isSchedulerEligible(SESSION_STATUS.SLEEPING, "Execute Email", "2026-07-23T11:00:00.000Z", now),
      true,
    );
  });

  it("excludes None and Human Review", () => {
    assert.equal(
      isSchedulerEligible(SESSION_STATUS.PENDING, "None", "2026-07-23T11:00:00.000Z", now),
      false,
    );
    assert.equal(
      isSchedulerEligible(SESSION_STATUS.PENDING, "Human Review", "2026-07-23T11:00:00.000Z", now),
      false,
    );
  });
});

describe("validators", () => {
  it("rejects empty client", () => {
    assert.throws(
      () => validateSessionBeforeBrowser(base({ clientPageId: null, clientPageUrl: null })),
      SkipError,
    );
  });

  it("rejects DNC before submit", () => {
    assert.throws(() => validateSessionBeforeSubmit(base({ clientDnc: true }), "c1"), SkipError);
  });
});

describe("decideErrorAction", () => {
  it("allows pre-submit retry then stops", () => {
    assert.equal(decideErrorAction("before-submit", 0, false), "technical-retry");
    assert.equal(decideErrorAction("before-submit", 2, false), "mark-error");
    assert.equal(decideErrorAction("post-submit-ambiguous", 0, true), "mark-error");
  });
});

describe("isRealConversationUrl", () => {
  it("rejects t=new stubs and prompt pages", () => {
    const prompt = "https://app.notion.com/p/FC2-0-Outreach-Controller-Prompt-a2ca22b20dde47a8b63e5b24e8131e5e";
    assert.equal(isRealConversationUrl(`${prompt}?t=new`, [prompt]), false);
    assert.equal(isRealConversationUrl(prompt, [prompt]), false);
    assert.equal(
      isRealConversationUrl("https://www.notion.so/chat/abc123def456", [prompt]),
      true,
    );
  });

  it("accepts chat routes even on notion host", () => {
    assert.equal(
      isRealConversationUrl("https://www.notion.so/chat/deadbeef", []),
      true,
    );
  });

  it("rejects Notion API endpoints mistakenly captured from network", () => {
    assert.equal(
      isRealConversationUrl(
        "https://app.notion.com/api/v3/syncRecordValuesSpaceInitial",
        [],
      ),
      false,
    );
  });

  it("rejects arbitrary notion pages without chat markers", () => {
    assert.equal(
      isRealConversationUrl(
        "https://www.notion.so/f9c6eff2-fc55-438e-b4a3-7534f749fe0d",
        [],
      ),
      false,
    );
  });
});
