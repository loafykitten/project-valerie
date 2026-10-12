import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPromptService, openStore } from "../src";
import { mergeTtsContent, mergeTtsPrompts } from "../src/features/prompts/merge-tts";

const telegram = "Write the words to be spoken in a Telegram voice note.";
const desktop = "Write the words to be spoken aloud by the desktop companion.";

test("shared TTS merge generalizes scaffold only, deduplicates equivalent text, and retains custom instructions", () => {
  expect(
    mergeTtsContent(`${telegram} Shared instructions.\n`, `${desktop} Shared instructions.`),
  ).toBe("Write the words to be spoken aloud. Shared instructions.\n");
  expect(mergeTtsContent("Custom Telegram phrasing.\n", "Custom desktop phrasing.")).toBe(
    "Custom Telegram phrasing.\n\n\nCustom desktop phrasing.",
  );
  expect(mergeTtsContent("", "Keep this exact custom text.\n")).toBe(
    "Keep this exact custom text.\n",
  );
});

test("migration preserves prior shared revisions, merges at the earliest voice position, and survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "valerie-tts-"));
  const path = join(dir, "test.sqlite");
  let store = openStore(path);
  try {
    const prompts = createPromptService(store);
    const old = prompts.update("channel.telegram-voice", {
      content: `${telegram} Shared rule.\n`,
      expectedVersion: 1,
    });
    store.db
      .query(
        "INSERT INTO core_prompts VALUES ('channel.desktop-voice','Desktop Speech','Old',?,1,'old')",
      )
      .run(`${desktop} Shared rule.`);
    store.db
      .query("INSERT INTO core_prompt_revisions VALUES ('channel.desktop-voice',1,?,'old')")
      .run(`${desktop} Shared rule.`);
    const order = prompts.catalog();
    const ids = [
      "channel.desktop-voice",
      ...order.prompts.map((p) => p.id).filter((id) => id !== "channel.desktop-voice"),
    ];
    store.db
      .query("UPDATE core_prompt_order SET ids_json=? WHERE singleton=1")
      .run(JSON.stringify(ids));
    const unchanged = store.db
      .query(
        "SELECT id,content,version,updated_at FROM core_prompts WHERE id NOT IN ('channel.telegram-voice','channel.desktop-voice') ORDER BY id",
      )
      .all();
    store.db.query("DELETE FROM core_migrations WHERE id='004-shared-tts'").run();
    store.close();
    store = openStore(path);
    const merged = createPromptService(store);
    expect(merged.list()).toHaveLength(16);
    expect(merged.get("channel.desktop-voice")).toBeUndefined();
    expect(merged.get("channel.telegram-voice")?.content).toBe(
      "Write the words to be spoken aloud. Shared rule.\n",
    );
    expect(merged.history("channel.telegram-voice")[1]?.content).toBe(old.content);
    expect(merged.catalog().prompts[0]?.id).toBe("channel.telegram-voice");
    expect(merged.catalog().orderVersion).toBe(order.orderVersion + 1);
    expect(
      store.db
        .query(
          "SELECT id,content,version,updated_at FROM core_prompts WHERE id NOT IN ('channel.telegram-voice','channel.desktop-voice') ORDER BY id",
        )
        .all(),
    ).toEqual(unchanged);
    expect(merged.compose("desktop-voice").content).toBe(merged.compose("telegram-voice").content);
    expect(merged.compose("telegram-text").content).not.toContain("# TTS Conversation Direction");
    expect(merged.compose("telegram-text").content).toContain("# Text Conversation Direction");
    const saved = merged.catalog();
    store.close();
    store = openStore(path);
    expect(createPromptService(store).catalog()).toEqual(saved);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized distinct voice instructions fail without deleting either section", () => {
  const store = openStore(":memory:");
  try {
    const prompts = createPromptService(store);
    prompts.update("channel.telegram-voice", { content: "a".repeat(150000), expectedVersion: 1 });
    store.db
      .query("INSERT INTO core_prompts VALUES ('channel.desktop-voice','Desktop','Old',?,1,'old')")
      .run("b".repeat(150000));
    expect(() => store.db.transaction(() => mergeTtsPrompts(store.db)).immediate()).toThrow(
      "size limit",
    );
    expect(prompts.get("channel.desktop-voice")?.content.length).toBe(150000);
    expect(prompts.get("channel.telegram-voice")?.version).toBe(2);
  } finally {
    store.close();
  }
});
