import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPromptService,
  defaultImageGenerationPrompt,
  openStore,
  PromptConflictError,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
function setup(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  return { store, prompts: createPromptService(store) };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("live prompt store", () => {
  test("scheduled guidance stays conditional and preserves independently edited revisions", () => {
    const { prompts } = setup();
    const before = prompts.compose("telegram-text", { habitCheckin: true, agreements: true });
    prompts.update("habits", {
      content: "Fictional brief agreed-practice guidance.",
      expectedVersion: 1,
    });
    const next = prompts.compose("telegram-text", { habitCheckin: true, agreements: true });
    expect(before.versions.habits).toBe(1);
    expect(next.versions.habits).toBe(2);
    expect(next.versions.rules).toBe(1);
    expect(next.versions.reminders).toBeUndefined();
    const reminder = prompts.compose("telegram-text", { reminderDelivery: true });
    expect(reminder.versions.reminders).toBe(1);
    expect(reminder.versions.habits).toBeUndefined();
    expect(reminder.versions.rules).toBeUndefined();
    const ordinary = prompts.compose("telegram-text", { agreements: true });
    expect(ordinary.versions.rules).toBe(1);
    expect(ordinary.versions.habits).toBeUndefined();
    expect(ordinary.versions.reminders).toBeUndefined();
    for (const snapshot of [
      prompts.compose("telegram-text"),
      prompts.compose("telegram-voice", { habitCheckin: true, reminderDelivery: true }),
    ]) {
      expect(snapshot.versions.habits).toBeUndefined();
      expect(snapshot.versions.reminders).toBeUndefined();
    }
  });

  test("seeded character fields stay empty and channels are isolated", () => {
    const { prompts } = setup();
    for (const id of ["personality", "relationship", "voice"])
      expect(prompts.get(id)?.content).toBe("");
    const voice = prompts.compose("telegram-voice");
    expect(voice.prompts.map((prompt) => prompt.id)).toEqual([
      "identity",
      "personality",
      "conversation-context",
      "relationship",
      "voice",
      "channel.telegram-voice",
    ]);
    const textPrompt = prompts.get("channel.telegram-text");
    if (!textPrompt) throw new Error("Missing text channel prompt");
    expect(voice.content).not.toContain(textPrompt.content);
    expect(prompts.list()).toHaveLength(16);
  });

  test("time and memory guidance preserve owner edits, empty revisions and channel eligibility", () => {
    const { store, prompts } = setup();
    const catalog = prompts.catalog();
    const ids = catalog.prompts.map((prompt) => prompt.id);
    expect(ids.slice(ids.indexOf("personality"), ids.indexOf("personality") + 3)).toEqual([
      "personality",
      "conversation-context",
      "memory-direction",
    ]);
    const first = prompts.compose("telegram-text", { memoryTools: true });
    expect(first.versions["conversation-context"]).toBe(1);
    expect(first.versions["memory-direction"]).toBe(1);
    prompts.update("conversation-context", {
      content: "  Fictional time guidance.\n",
      expectedVersion: 1,
    });
    prompts.update("memory-direction", { content: "", expectedVersion: 1 });
    const reopened = createPromptService(store);
    const next = reopened.compose("telegram-text", { memoryTools: true });
    expect(next.content).toContain("  Fictional time guidance.\n");
    expect(next.versions["memory-direction"]).toBe(2);
    expect(next.content).not.toContain("# Memory Use");
    expect(first.versions["memory-direction"]).toBe(1);
    expect(reopened.compose("telegram-text").versions["memory-direction"]).toBeUndefined();
    expect(
      reopened.compose("telegram-voice", { memoryTools: true }).versions["memory-direction"],
    ).toBeUndefined();
    expect(reopened.compose("desktop-voice").content).toContain("Fictional time guidance.");
  });

  test("image direction is editable with revisions and only composes into enabled text conversations", () => {
    const { store, prompts } = setup();
    expect(prompts.get("image-generation")).toMatchObject({
      title: "Image Generation",
      content: defaultImageGenerationPrompt,
      version: 1,
    });
    const original = prompts.compose("telegram-text", { imageGeneration: true });
    expect(original.content).toContain(`# Image Generation\n\n${defaultImageGenerationPrompt}`);
    const authored = "  Choose a cozy scene and acknowledge the wait in my own voice.\n";
    prompts.update("image-generation", { content: authored, expectedVersion: 1 });
    const edited = createPromptService(store).compose("telegram-text", { imageGeneration: true });
    expect(edited.versions["image-generation"]).toBe(2);
    expect(edited.content).toContain(authored);
    expect(edited.content).not.toContain(defaultImageGenerationPrompt);
    expect(original.versions["image-generation"]).toBe(1);
    expect(original.content).not.toContain(authored);
    expect(
      prompts.history("image-generation").map(({ version, content }) => ({ version, content })),
    ).toEqual([
      { version: 2, content: authored },
      { version: 1, content: defaultImageGenerationPrompt },
    ]);
    for (const snapshot of [
      prompts.compose("telegram-text"),
      prompts.compose("telegram-text", { imageGeneration: false }),
      prompts.compose("telegram-voice", { imageGeneration: true }),
      prompts.compose("desktop-voice", { imageGeneration: true }),
    ]) {
      expect(snapshot.versions["image-generation"]).toBeUndefined();
      expect(snapshot.content).not.toContain(authored);
      expect(snapshot.content).not.toContain(defaultImageGenerationPrompt);
    }
    prompts.update("image-generation", { content: "", expectedVersion: 2 });
    const cleared = createPromptService(store).compose("telegram-text", { imageGeneration: true });
    expect(cleared.versions["image-generation"]).toBe(3);
    expect(cleared.prompts.find(({ id }) => id === "image-generation")?.content).toBe("");
    expect(cleared.content).not.toContain("# Image Generation");
    expect(cleared.content).not.toContain(defaultImageGenerationPrompt);
  });

  test("updates are verbatim, immediately composed, and reject stale writes", () => {
    const { prompts } = setup();
    const initial = prompts.compose("telegram-text");
    const authored = "  {{char}} says: ‘Hello, {{user}}.’\n*smiles* 💜\n";
    const saved = prompts.update("personality", { content: authored, expectedVersion: 1 });
    expect(saved.version).toBe(2);
    expect(prompts.compose("telegram-text").prompts[1]?.content).toBe(authored);
    expect(prompts.compose("telegram-text").versions.personality).toBe(2);
    expect(initial.versions.personality).toBe(1);
    expect(() =>
      prompts.update("personality", { content: "stale overwrite", expectedVersion: 1 }),
    ).toThrow(PromptConflictError);
    expect(prompts.get("personality")?.content).toBe(authored);
    expect(
      prompts.history("personality").map(({ version, content }) => ({ version, content })),
    ).toEqual([
      { version: 2, content: authored },
      { version: 1, content: "" },
    ]);
  });

  test("reopening the database preserves prompt content and history", () => {
    const directory = mkdtempSync(join(tmpdir(), "valerie-core-"));
    directories.push(directory);
    const path = join(directory, "nested", "valerie.sqlite");
    const first = setup(path);
    first.prompts.update("relationship", {
      content: "My authored relationship.\n",
      expectedVersion: 1,
    });
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);
    const reopened = setup(path);
    expect(reopened.prompts.get("relationship")?.content).toBe("My authored relationship.\n");
    expect(reopened.prompts.get("relationship")?.version).toBe(2);
    expect(reopened.prompts.history("relationship")).toHaveLength(2);
    expect(reopened.store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(reopened.store.db.query("SELECT count(*) AS count FROM core_migrations").get()).toEqual({
      count: 21,
    });
  });

  test("a second database connection sees live edits and cannot overwrite a stale version", () => {
    const directory = mkdtempSync(join(tmpdir(), "valerie-core-concurrent-"));
    directories.push(directory);
    const path = join(directory, "valerie.sqlite");
    const first = setup(path);
    const second = setup(path);
    const stale = second.prompts.get("voice");
    expect(stale).toBeDefined();
    first.prompts.update("voice", { content: "A saved speech preference.", expectedVersion: 1 });
    expect(second.prompts.compose("desktop-voice").versions.voice).toBe(2);
    expect(() =>
      second.prompts.update("voice", {
        content: "An older edit",
        expectedVersion: stale?.version ?? 0,
      }),
    ).toThrow(PromptConflictError);
    expect(second.prompts.history("voice")).toHaveLength(2);
  });
});
