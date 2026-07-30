import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  detectPlanDrift,
  isOutboundAction,
  parseOutreachStateJson,
} from "../../src/notion/outreachState.js";

/**
 * Real Outreach State JSON from the 2026-07-29 multi-worker incident.
 * Plan put touch M2 on Aug 3; Next Wake At had been rewritten to "now".
 */
const RMBR_STATE = JSON.stringify({
  schema_version: "2.0",
  model_state: {
    communication_model: "Pre-Exhibition",
    anchor_name: "Newtopia Now 2026",
    sequence_id: "notion-980:email:Pre-Exhibition:2026-07-29T10:29:07.159Z",
    model_touch_index: 1,
    next_touch_at: "2026-08-03T14:31:00.000Z",
    evaluated_at: "2026-07-29T11:28:08.062Z",
    schedule_mode: "REFLOW",
  },
});

const HEALTHY_STATE = JSON.stringify({
  schema_version: "2.0",
  model_state: {
    model_touch_index: 1,
    next_touch_at: "2026-07-31T14:24:00.000Z",
  },
});

describe("parseOutreachStateJson", () => {
  it("reads next_touch_at out of model_state", () => {
    const parsed = parseOutreachStateJson(RMBR_STATE);
    assert.equal(parsed?.nextTouchAt, "2026-08-03T14:31:00.000Z");
    assert.equal(parsed?.modelTouchIndex, 1);
    assert.equal(
      parsed?.sequenceId,
      "notion-980:email:Pre-Exhibition:2026-07-29T10:29:07.159Z",
    );
  });

  it("tolerates a double-encoded rich text value", () => {
    assert.equal(
      parseOutreachStateJson(JSON.stringify(RMBR_STATE))?.nextTouchAt,
      "2026-08-03T14:31:00.000Z",
    );
  });

  it("returns null for empty or broken JSON", () => {
    assert.equal(parseOutreachStateJson(null), null);
    assert.equal(parseOutreachStateJson("   "), null);
    assert.equal(parseOutreachStateJson("{not json"), null);
  });
});

describe("isOutboundAction", () => {
  it("covers only the actions that send messages", () => {
    assert.equal(isOutboundAction("Execute Email"), true);
    assert.equal(isOutboundAction("Execute LinkedIn"), true);
    assert.equal(isOutboundAction("Plan"), false);
    assert.equal(isOutboundAction("Handle Reply"), false);
    assert.equal(isOutboundAction(null), false);
  });
});

describe("detectPlanDrift — 2026-07-29 duplicate-send incident", () => {
  const incidentNow = new Date("2026-07-29T11:37:00.000Z");

  it("blocks the RMBR Kombucha send that actually went out 5 days early", () => {
    const drift = detectPlanDrift(
      {
        nextAction: "Execute Email",
        nextWakeAt: "2026-07-29T11:31:00.000Z",
        outreachStateJson: RMBR_STATE,
      },
      incidentNow,
    );
    assert.ok(drift, "expected the premature Execute Email to be flagged");
    assert.equal(drift!.plannedAt, "2026-08-03T14:31:00.000Z");
    assert.equal(drift!.wakeAt, "2026-07-29T11:31:00.000Z");
    assert.ok(drift!.driftMs > 4 * 24 * 60 * 60 * 1000);
  });

  it("blocks the Omne Diem M2 that followed M1 by 50 minutes", () => {
    const drift = detectPlanDrift(
      {
        nextAction: "Execute Email",
        nextWakeAt: "2026-07-29T11:25:00.000Z",
        outreachStateJson: JSON.stringify({
          model_state: { model_touch_index: 1, next_touch_at: "2026-08-03T15:42:00Z" },
        }),
      },
      new Date("2026-07-29T11:35:00.000Z"),
    );
    assert.ok(drift);
    assert.equal(drift!.plannedAt, "2026-08-03T15:42:00Z");
  });

  it("blocks an Execute row whose Next Wake At was cleared", () => {
    const drift = detectPlanDrift(
      { nextAction: "Execute Email", nextWakeAt: null, outreachStateJson: RMBR_STATE },
      incidentNow,
    );
    assert.ok(drift);
  });

  it("passes a healthy row where Next Wake At mirrors the plan", () => {
    assert.equal(
      detectPlanDrift(
        {
          nextAction: "Execute Email",
          nextWakeAt: "2026-07-31T14:24:00.000Z",
          outreachStateJson: HEALTHY_STATE,
        },
        new Date("2026-07-31T14:24:05.000Z"),
      ),
      null,
    );
  });

  it("passes a due row whose plan is now in the past", () => {
    assert.equal(
      detectPlanDrift(
        {
          nextAction: "Execute Email",
          nextWakeAt: "2026-08-03T14:31:00.000Z",
          outreachStateJson: RMBR_STATE,
        },
        new Date("2026-08-03T14:35:00.000Z"),
      ),
      null,
    );
  });

  it("never blocks Plan runs, which legitimately precede the next touch", () => {
    // Ancient Nutrition: Plan due 11:29 while next_touch_at is 14:37 — correct.
    assert.equal(
      detectPlanDrift(
        {
          nextAction: "Plan",
          nextWakeAt: "2026-07-29T11:29:00.000Z",
          outreachStateJson: JSON.stringify({
            model_state: { next_touch_at: "2026-07-29T14:37:00Z" },
          }),
        },
        new Date("2026-07-29T11:30:00.000Z"),
      ),
      null,
    );
  });

  it("ignores rows with no plan yet", () => {
    assert.equal(
      detectPlanDrift(
        {
          nextAction: "Execute Email",
          nextWakeAt: "2026-07-29T11:31:00.000Z",
          outreachStateJson: null,
        },
        incidentNow,
      ),
      null,
    );
  });
});

/**
 * Next Wake At mirrors the Prompt's plan. Any worker path that writes it as a
 * technical timer makes the row permanently due and lets Execute fire early —
 * the root cause of the incident. Only the two functions that copy Prompt-owned
 * values back may touch it.
 */
describe("Next Wake At ownership", () => {
  it("is only written by the Prompt-mirroring functions", async () => {
    const source = await readFile(
      new URL("../../src/notion/sessionRepository.ts", import.meta.url),
      "utf-8",
    );
    const allowed = new Set([
      "applyControlJsonWriteback",
      "healSessionScheduleFromPlan",
      "parkSessionOutOfDueQueue",
    ]);
    const offenders: string[] = [];
    let currentFn = "<module>";

    for (const line of source.split("\n")) {
      const declaration = line.match(
        /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/,
      );
      if (declaration) currentFn = declaration[1];
      if (/\[ids\.nextWakeAt\]\s*:/.test(line) && !allowed.has(currentFn)) {
        offenders.push(`${currentFn}: ${line.trim()}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Next Wake At must stay Prompt-owned; unexpected writers:\n${offenders.join("\n")}`,
    );
  });
});
