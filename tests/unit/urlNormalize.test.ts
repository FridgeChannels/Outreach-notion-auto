import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNotionPageUrl,
  buildOutreachMessage,
  toChatEntryUrl,
  extractCompactPageId,
} from "../../src/config.js";
import { parsePageUrl, pageIdToUrl } from "../../src/notion/helpers.js";

describe("normalizeNotionPageUrl", () => {
  it("strips hyphens and uses www.notion.so compact id", () => {
    assert.equal(
      normalizeNotionPageUrl("https://app.notion.com/p/a2ca22b20dde47a8b63e5b24e8131e5e"),
      "https://www.notion.so/a2ca22b20dde47a8b63e5b24e8131e5e",
    );
  });

  it("strips dashed www.notion.so ids to compact", () => {
    assert.equal(
      normalizeNotionPageUrl("https://www.notion.so/a2ca22b2-0dde-47a8-b63e-5b24e8131e5e"),
      "https://www.notion.so/a2ca22b20dde47a8b63e5b24e8131e5e",
    );
  });

  it("toChatEntryUrl uses app.notion.com/p/compact (no hyphens)", () => {
    assert.equal(
      toChatEntryUrl("https://www.notion.so/a2ca22b2-0dde-47a8-b63e-5b24e8131e5e"),
      "https://app.notion.com/p/a2ca22b20dde47a8b63e5b24e8131e5e",
    );
    assert.equal(
      toChatEntryUrl("https://app.notion.com/p/a2ca22b2-0dde-47a8-b63e-5b24e8131e5e"),
      "https://app.notion.com/p/a2ca22b20dde47a8b63e5b24e8131e5e",
    );
  });

  it("extractCompactPageId removes hyphens", () => {
    assert.equal(
      extractCompactPageId("https://app.notion.com/p/a2ca22b2-0dde-47a8-b63e-5b24e8131e5e"),
      "a2ca22b20dde47a8b63e5b24e8131e5e",
    );
  });
});

describe("parsePageUrl", () => {
  it("parses dashed www.notion.so urls that SDK extractPageId rejects", () => {
    assert.equal(
      parsePageUrl("https://www.notion.so/3a59166f-d9fd-81ba-a5ee-ca41296fa6ea"),
      "3a59166f-d9fd-81ba-a5ee-ca41296fa6ea",
    );
  });

  it("parses compact www.notion.so urls", () => {
    assert.equal(
      parsePageUrl("https://www.notion.so/3a59166fd9fd81baa5eeca41296fa6ea"),
      "3a59166f-d9fd-81ba-a5ee-ca41296fa6ea",
    );
  });

  it("round-trips with pageIdToUrl", () => {
    const id = "3a59166f-d9fd-81ba-a5ee-ca41296fa6ea";
    assert.equal(parsePageUrl(pageIdToUrl(id)), id);
  });
});

describe("buildOutreachMessage", () => {
  it("builds single-line @mention prompt with compact ids", () => {
    process.env.OUTREACH_CONTROLLER_PROMPT_URL =
      "https://app.notion.com/p/a2ca22b20dde47a8b63e5b24e8131e5e";
    const msg = buildOutreachMessage("https://www.notion.so/3a59166fd9fd817bb5e8cfbf87f1834d");
    assert.equal(
      msg,
      "请运行以下 Prompt： @https://www.notion.so/a2ca22b20dde47a8b63e5b24e8131e5e ；执行公司： @https://www.notion.so/3a59166fd9fd817bb5e8cfbf87f1834d",
    );
  });
});
