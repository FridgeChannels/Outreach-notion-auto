import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OUTREACH_BATCH_LIMIT } from "../../src/config.js";

describe("OUTREACH_BATCH_LIMIT", () => {
  it("defaults to a positive integer", () => {
    assert.equal(typeof OUTREACH_BATCH_LIMIT, "number");
    assert.ok(OUTREACH_BATCH_LIMIT >= 1);
  });
});
