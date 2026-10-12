import { afterEach, expect, test } from "bun:test";
import { createConversationService, type Store } from "@valerie/core";
import { required, scheduledFixture } from "../reminders/test-fixture";
import { captureToolCatalog } from "../tools/catalog";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("available rule tools do not imply an active agreement; each turn pins the actual stored state", () => {
  const f = scheduledFixture();
  stores.push(f.store);
  const conversations = createConversationService(f.store, {
    now: f.now,
    agreementTools: true,
    captureToolCatalog: (flags) => captureToolCatalog(f.store, flags),
  });
  f.accept("I like that we can agree on rules together.");
  const first = required(conversations.startNextTurn());
  expect(
    first.snapshot.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes(
          "0 applicable saved rules; 0 active saved habits; no current Growth Focus",
        ),
    ),
  ).toBe(true);
  conversations.failGeneration(first.id, { code: "fixture_no_delivery" });
  f.agreements.saveRule(
    {
      name: "A fictional drawing break",
      meaning: "Take a break from the fictional public feed.",
      reason: "Make room for drawing.",
      scope: "Leisure feed browsing.",
      effectiveAt: f.now().toISOString(),
      expiresAt: null,
      timezone: "America/Chicago",
      window: null,
      exceptions: ["Direct messages with friends are welcome."],
      condition: null,
    },
    { actor: "owner" },
  );
  f.advance(1000);
  f.accept("How is our agreed break recorded?");
  const next = required(conversations.startNextTurn());
  expect(
    next.snapshot.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("1 applicable saved rules;"),
    ),
  ).toBe(true);
  expect(first.snapshot.agreements?.rules).toHaveLength(0);
  expect(next.snapshot.agreements?.rules).toHaveLength(1);
});
