import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rotateForWorker } from "../../src/flows/poll.js";
import { isSchedulerEligible } from "../../src/flows/validators.js";
import { SESSION_STATUS } from "../../src/config.js";
import type { DueSessionRow } from "../../src/notion/sessionRepository.js";

function rows(n: number): DueSessionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    pageId: `p${i}`,
    pageUrl: `https://www.notion.so/p${i}`,
    nextWakeAt: "2026-07-29T11:00:00.000Z",
  }));
}

describe("rotateForWorker", () => {
  it("keeps every due row exactly once", () => {
    const due = rows(10);
    const rotated = rotateForWorker(due, "worker-ella");
    assert.equal(rotated.length, due.length);
    assert.deepEqual(
      [...rotated].map((r) => r.pageId).sort(),
      due.map((r) => r.pageId).sort(),
    );
  });

  it("gives the five accounts different starting rows", () => {
    const due = rows(10);
    const heads = new Set(
      ["ella", "molly", "hayes", "julian", "thomas"].map(
        (a) => rotateForWorker(due, `worker-${a}`)[0].pageId,
      ),
    );
    assert.ok(heads.size >= 3, `expected spread starts, got ${[...heads].join(",")}`);
  });

  it("is stable for one worker and safe for tiny lists", () => {
    const due = rows(4);
    assert.deepEqual(rotateForWorker(due, "worker-ella"), rotateForWorker(due, "worker-ella"));
    assert.deepEqual(rotateForWorker(rows(1), "worker-ella").length, 1);
    assert.deepEqual(rotateForWorker([], "worker-ella"), []);
  });
});

describe("isSchedulerEligible as the post-lock re-check", () => {
  const now = new Date("2026-07-29T11:35:00.000Z");

  it("rejects a row the Prompt already put to sleep for August", () => {
    assert.equal(
      isSchedulerEligible(
        SESSION_STATUS.SLEEPING,
        "Execute Email",
        "2026-08-04T18:12:00.000Z",
        now,
      ),
      false,
    );
  });

  it("rejects a row parked for Human Review", () => {
    assert.equal(
      isSchedulerEligible(
        SESSION_STATUS.PENDING,
        "Human Review",
        "2026-07-29T11:20:00.000Z",
        now,
      ),
      false,
    );
  });

  it("rejects a row another worker is already running", () => {
    assert.equal(
      isSchedulerEligible(
        SESSION_STATUS.RUNNING,
        "Execute Email",
        "2026-07-29T11:00:00.000Z",
        now,
      ),
      false,
    );
  });

  it("accepts a genuinely due row", () => {
    assert.equal(
      isSchedulerEligible(
        SESSION_STATUS.SLEEPING,
        "Execute Email",
        "2026-07-29T11:31:00.000Z",
        now,
      ),
      true,
    );
  });
});
