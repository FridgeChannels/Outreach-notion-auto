import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionKey,
  clearExpiredRetryCooldowns,
  clearRetryCooldown,
  getRetryCooldown,
  isExecutionSubmitted,
  isRetryCoolingDown,
  setRetryCooldown,
  acquireExecutionLock,
  markExecutionSubmitted,
  releaseExecutionLock,
} from "../../src/locks.js";

describe("retry cooldown", () => {
  it("holds a session back until the backoff window passes", async () => {
    const pageId = `cooldown-${Date.now()}`;
    const notBefore = new Date(Date.now() + 60_000);
    await setRetryCooldown(pageId, notBefore, "Running visibility not confirmed");

    assert.equal(await isRetryCoolingDown(pageId), true);
    const record = await getRetryCooldown(pageId);
    assert.equal(record?.notBefore, notBefore.toISOString());
    assert.match(record!.reason, /Running visibility/);

    // Same file is read by every worker, so the backoff is fleet-wide.
    assert.equal(await isRetryCoolingDown(pageId, new Date(Date.now() + 61_000)), false);
    await clearRetryCooldown(pageId);
    assert.equal(await isRetryCoolingDown(pageId), false);
  });

  it("reports no cooldown for an unknown session", async () => {
    assert.equal(await isRetryCoolingDown(`never-seen-${Date.now()}`), false);
  });

  it("sweeps windows that already elapsed", async () => {
    const pageId = `cooldown-expired-${Date.now()}`;
    await setRetryCooldown(pageId, new Date(Date.now() - 1_000), "old");
    const removed = await clearExpiredRetryCooldowns();
    assert.ok(removed >= 1);
    assert.equal(await getRetryCooldown(pageId), null);
  });
});

describe("buildExecutionKey", () => {
  it("separates two touches of the same Session and action", async () => {
    const sessionId = `outreach:${Date.now()}`;
    const m1 = buildExecutionKey(sessionId, "2026-07-29T15:07:00.000Z", "Execute Email");
    const m2 = buildExecutionKey(sessionId, "2026-08-03T14:31:00.000Z", "Execute Email");
    assert.notEqual(m1, m2);
  });

  it("keeps one key per touch so a resend is blocked", () => {
    const key = buildExecutionKey("s1", "2026-08-03T14:31:00.000Z", "Execute Email");
    assert.equal(
      key,
      buildExecutionKey("s1", "2026-08-03T14:31:00.000Z", "Execute Email"),
    );
  });

  it("falls back to a stable placeholder when the touch is unknown", () => {
    assert.equal(buildExecutionKey("s1", null, "Plan"), "s1:none:Plan");
  });
});

describe("isExecutionSubmitted", () => {
  it("is true only after markExecutionSubmitted", async () => {
    const key = buildExecutionKey(`submitted-${Date.now()}`, "touch-1", "Plan");
    assert.equal(await isExecutionSubmitted(key), false);
    const token = await acquireExecutionLock(key);
    assert.ok(token);
    assert.equal(await isExecutionSubmitted(key), false);
    await markExecutionSubmitted(key, token!, "https://www.notion.so/chat/x");
    assert.equal(await isExecutionSubmitted(key), true);
    // Must still block a second acquire — this is what caused Claimed↔Pending loops
    // when poll kept reclaiming an already-finished touch.
    assert.equal(await acquireExecutionLock(key), null);
    await releaseExecutionLock(key, token!, { onlyIfNotSubmitted: true });
    assert.equal(await isExecutionSubmitted(key), true);
  });
});
