import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickChatRotateLimit } from "../../src/flows/chatReuse.js";

describe("pickChatRotateLimit", () => {
  it("returns inclusive values in [min, max]", () => {
    for (let i = 0; i < 80; i++) {
      const n = pickChatRotateLimit(15, 25);
      assert.ok(n >= 15 && n <= 25, `got ${n}`);
    }
  });

  it("handles min === max", () => {
    assert.equal(pickChatRotateLimit(20, 20), 20);
  });

  it("swaps inverted bounds", () => {
    for (let i = 0; i < 20; i++) {
      const n = pickChatRotateLimit(25, 15);
      assert.ok(n >= 15 && n <= 25, `got ${n}`);
    }
  });
});
