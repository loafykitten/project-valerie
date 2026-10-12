import { afterEach, expect, test } from "bun:test";
import type { Store } from "@valerie/core";
import { scheduledFixture } from "../reminders/test-fixture";
import { createAgreementTools } from "./agreements";
import { createToolRegistry } from "./registry";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function fixture(valueKind: "count" | "status" = "count") {
  const f = scheduledFixture();
  stores.push(f.store);
  f.agreements.saveSettings({
    expectedVersion: f.agreements.getSettings().version,
    allowValerieManageHabits: true,
    allowValerieManageRules: false,
  });
  const behavior = f.daily.saveBehavior(
    {
      name: "Fictional creative practice",
      unit: valueKind === "count" ? "sessions" : "report",
      valueKind,
    },
    { actor: "owner" },
  );
  const source = f.accept("I agree to two painting sessions. Private source marker.");
  const registry = createToolRegistry(
    f.store,
    createAgreementTools(f.store, {
      now: f.now,
      permissions: { manageHabits: true, manageRules: false },
    }),
  );
  let callNumber = 0;
  const call = (changes: Record<string, unknown> = {}) =>
    registry.execute(
      {
        id: `repair-${callNumber}`,
        name: "agreement_write",
        arguments: JSON.stringify({
          target: "habit",
          action: "save",
          habit: {
            name: "Private title marker",
            reason: "Make room for enjoyment.",
            behaviorId: behavior.id,
            fullPractice: "Complete the agreed creative practice.",
            cadence: { kind: "every_waking_day" },
            slots: ["evening"],
            effectiveAt: f.now().toISOString(),
            sourceIds: [source.sourceId],
            ...changes,
          },
        }),
      },
      {
        turnId: source.turnId,
        operationKey: `repair-${callNumber++}`,
        signal: new AbortController().signal,
      },
      () => {},
    );
  return { ...f, call };
}

test("a missing count threshold gives safe actionable repair feedback and the corrected tool request saves once", async () => {
  const f = fixture();
  const rejected = await f.call();
  expect(rejected).toMatchObject({
    status: "rejected",
    code: "invalid_arguments",
    field: "threshold",
    reason: "count_threshold_required",
  });
  expect(rejected.message).toContain("agreed whole-number target");
  expect(rejected.message).toContain("rather than inventing one");
  expect(JSON.stringify(rejected)).not.toContain("Private source marker");
  expect(JSON.stringify(rejected)).not.toContain("Private title marker");
  expect(f.agreements.listHabits()).toEqual([]);
  expect(await f.call({ threshold: 2 })).toMatchObject({
    status: "succeeded",
    result: { habit: { version: 1, threshold: 2 } },
  });
  expect(f.agreements.listHabits()).toHaveLength(1);
});

test("habit semantic validation identifies status targets, missing weekdays, invalid times and UTF-8 meaning bounds", async () => {
  const f = fixture("status");
  expect(await f.call({ threshold: 1 })).toMatchObject({
    status: "rejected",
    field: "threshold",
    reason: "status_threshold_not_applicable",
  });
  expect(await f.call({ cadence: { kind: "weekdays" } })).toMatchObject({
    status: "rejected",
    field: "cadence.weekdays",
    reason: "invalid_weekdays",
  });
  expect(await f.call({ effectiveAt: "2026-02-30T18:00:00Z" })).toMatchObject({
    status: "rejected",
    field: "effectiveAt",
    reason: "invalid_timestamp",
  });
  const meaning = await f.call({ fullPractice: "é".repeat(301) });
  expect(meaning).toMatchObject({
    status: "rejected",
    field: "fullPractice",
    reason: "invalid_text",
  });
  expect(meaning.message).toContain("600 UTF-8 bytes");
  expect(f.agreements.listHabits()).toEqual([]);
});
