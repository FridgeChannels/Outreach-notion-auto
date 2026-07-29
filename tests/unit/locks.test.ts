import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acquireLock,
  releaseLock,
  validateLock,
  isLockHeld,
  acquireExecutionLock,
  markExecutionSubmitted,
  releaseExecutionLock,
  buildExecutionKey,
} from "../../src/locks.js";

describe("locks", () => {
  it("acquires once and rejects second", async () => {
    const id = `sess-${Date.now()}`;
    const t1 = await acquireLock("session", id);
    const t2 = await acquireLock("session", id);
    assert.ok(t1);
    assert.equal(t2, null);
    assert.equal(await validateLock("session", id, t1!), true);
    assert.equal(await isLockHeld("session", id), true);
    await releaseLock("session", id, t1!);
    assert.equal(await isLockHeld("session", id), false);
  });

  it("mailbox lock is separate namespace", async () => {
    const id = `mb-${Date.now()}`;
    const t1 = await acquireLock("mailbox", id);
    const t2 = await acquireLock("session", id);
    assert.ok(t1);
    assert.ok(t2);
    await releaseLock("mailbox", id, t1!);
    await releaseLock("session", id, t2!);
  });

  it("client lock is separate from session and blocks second acquirer", async () => {
    const clientId = `client-${Date.now()}`;
    const sessionId = `sess-${Date.now()}`;
    const c1 = await acquireLock("client", clientId);
    const s1 = await acquireLock("session", sessionId);
    assert.ok(c1);
    assert.ok(s1);
    assert.equal(await acquireLock("client", clientId), null);
    assert.equal(await isLockHeld("client", clientId), true);
    await releaseLock("client", clientId, c1!);
    await releaseLock("session", sessionId, s1!);
    assert.equal(await isLockHeld("client", clientId), false);
  });

  it("execution key blocks duplicate submit", async () => {
    const key = buildExecutionKey(`s-${Date.now()}`, "meeting:abc:1", "Plan");
    const t1 = await acquireExecutionLock(key);
    assert.ok(t1);
    const t2 = await acquireExecutionLock(key);
    assert.equal(t2, null);
    await markExecutionSubmitted(key, t1!, "https://www.notion.so/chat/abc");
    // After submit, lock must not be released for retry
    await releaseExecutionLock(key, t1!, { onlyIfNotSubmitted: true });
    const t3 = await acquireExecutionLock(key);
    assert.equal(t3, null);
  });
});
