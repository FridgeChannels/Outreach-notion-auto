import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.OUTREACH_CONTROLLER_PROMPT_URL = "https://www.notion.so/controller";
process.env.MAILBOX_REPLY_SCAN_PROMPT_URL = "https://www.notion.so/mailbox-scan";

const { buildOutreachMessage, buildMailboxMessage, NOTION_AI_MODEL_DEFAULT } = await import(
  "../../src/config.js"
);

describe("chat message builders", () => {
  it("outreach template uses @mention urls on one line (compact ids)", () => {
    process.env.OUTREACH_CONTROLLER_PROMPT_URL =
      "https://app.notion.com/p/a2ca22b20dde47a8b63e5b24e8131e5e";
    const client = "https://www.notion.so/3a59166fd9fd817bb5e8cfbf87f1834d";
    const msg = buildOutreachMessage(client);
    assert.equal(
      msg,
      "请运行以下 Prompt： @https://www.notion.so/a2ca22b20dde47a8b63e5b24e8131e5e ；执行公司： @https://www.notion.so/3a59166fd9fd817bb5e8cfbf87f1834d",
    );
  });

  it("mailbox template uses @mention urls on one line (compact ids)", () => {
    process.env.MAILBOX_REPLY_SCAN_PROMPT_URL =
      "https://app.notion.com/p/907ad7080d6c4c7587f0fcc7281bc6d7";
    const mb = "https://www.notion.so/f9c6eff2fc55438eb4a37534f749fe0d";
    const msg = buildMailboxMessage(mb);
    assert.equal(
      msg,
      "请运行以下 Prompt： @https://www.notion.so/907ad7080d6c4c7587f0fcc7281bc6d7 ；执行邮箱： @https://www.notion.so/f9c6eff2fc55438eb4a37534f749fe0d",
    );
  });

  it("default model is Auto", () => {
    assert.equal(NOTION_AI_MODEL_DEFAULT, "Auto");
  });
});
