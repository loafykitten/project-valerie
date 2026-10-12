import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCharacterService,
  createPromptService,
  openStore,
  PromptOrderConflictError,
  PromptOrderValidationError,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
function setup(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  return { store, prompts: createPromptService(store), characters: createCharacterService(store) };
}
const card = Buffer.from(
  JSON.stringify({
    description: "Fictional character",
    system_prompt: "Fictional behavior",
    post_history_instructions: "Fictional final rule",
  }),
);
const importOptions = { sourceFilename: "fictional.json", expectedActiveImportId: null } as const;
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("new time and memory sections join owner knowledge once without changing the existing order", () => {
  const { store, prompts } = setup();
  const original = prompts
    .catalog()
    .prompts.map((prompt) => prompt.id)
    .filter((id) => !["conversation-context", "memory-direction"].includes(id))
    .reverse();
  store.db.query("UPDATE core_prompt_order SET ids_json=?").run(JSON.stringify(original));
  const updated = createPromptService(store).catalog();
  const ids = updated.prompts.map((prompt) => prompt.id);
  expect(ids.filter((id) => !["conversation-context", "memory-direction"].includes(id))).toEqual(
    original,
  );
  expect(ids.slice(ids.indexOf("personality"), ids.indexOf("personality") + 3)).toEqual([
    "personality",
    "conversation-context",
    "memory-direction",
  ]);
  const moved = ["memory-direction", ...ids.filter((id) => id !== "memory-direction")];
  prompts.reorder({ ids: moved, expectedOrderVersion: updated.orderVersion });
  expect(
    createPromptService(store)
      .catalog()
      .prompts.map((prompt) => prompt.id),
  ).toEqual(moved);
});

test("saved order controls titled channel sections while after-history stays separate and content remains exact", () => {
  const { prompts, characters } = setup();
  characters.import(card, importOptions);
  for (const prompt of prompts.list()) {
    prompts.update(prompt.id, {
      content: `  Body: ${prompt.id}\n*exact* {{user}}\n`,
      expectedVersion: prompt.version,
    });
  }
  const original = prompts.catalog();
  const histories = original.prompts.map((prompt) => prompts.history(prompt.id));
  const oldSnapshot = prompts.compose("telegram-text");
  const pinned = "character.post-history";
  const ids = original.prompts
    .map((prompt) => prompt.id)
    .filter((id) => id !== pinned)
    .reverse()
    .concat(pinned);
  const saved = prompts.reorder({ ids, expectedOrderVersion: original.orderVersion });
  expect(saved.orderVersion).toBe(original.orderVersion + 1);
  expect(saved.prompts.map((prompt) => prompt.id)).toEqual(ids);
  expect(original.prompts.map((prompt) => prompts.get(prompt.id))).toEqual(original.prompts);
  expect(original.prompts.map((prompt) => prompts.history(prompt.id))).toEqual(histories);
  const excluded = [
    "reflection",
    "heartbeat",
    "reminders",
    "image-generation",
    "memory-direction",
    "growth-focus",
    "daily-records",
    "habits",
    "rules",
  ];
  for (const channel of ["telegram-text", "telegram-voice", "desktop-voice"] as const) {
    const snapshot = prompts.compose(channel);
    const included = saved.prompts.filter(
      (prompt) =>
        !excluded.includes(prompt.id) &&
        (!prompt.id.startsWith("channel.") ||
          prompt.id ===
            (channel === "telegram-text" ? "channel.telegram-text" : "channel.telegram-voice")) &&
        (channel === "telegram-text" || prompt.id !== "character.examples"),
    );
    expect(snapshot.prompts.map((prompt) => prompt.id)).toEqual(
      included.map((prompt) => prompt.id),
    );
    expect(snapshot.orderVersion).toBe(saved.orderVersion);
    expect(snapshot.content).toBe(
      included
        .filter((prompt) => prompt.id !== pinned)
        .map((prompt) => `# ${prompt.title}\n\n${prompt.content}`)
        .join("\n\n"),
    );
    expect(snapshot.postHistoryContent).toBe(
      `# Post-History Instructions\n\n${prompts.get(pinned)?.content}`,
    );
    expect(snapshot.postHistoryPlacement).toBe("after-history");
    expect(snapshot.content).not.toContain("Body: character.post-history");
  }
  expect(oldSnapshot.orderVersion).toBe(original.orderVersion);
  expect(oldSnapshot.prompts.map((prompt) => prompt.id)).not.toEqual(
    prompts.compose("telegram-text").prompts.map((prompt) => prompt.id),
  );
  expect(prompts.get("personality")?.title).toBe("Ember Knowledge");
  expect(prompts.compose("telegram-text").content).toContain("# Ember Knowledge\n\n");
  expect(
    prompts
      .list()
      .every((prompt) =>
        prompt.title.split(/[ -]/).every((word) => word[0] === word[0]?.toUpperCase()),
      ),
  ).toBe(true);
});

test("reorder is durable, conflict checked across connections, and independent of content revisions", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-order-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const first = setup(path);
  const second = setup(path);
  const before = first.prompts.catalog();
  const ids = before.prompts.map((prompt) => prompt.id).reverse();
  const saved = first.prompts.reorder({ ids, expectedOrderVersion: before.orderVersion });
  expect(second.prompts.catalog()).toEqual(saved);
  expect(() =>
    second.prompts.reorder({
      ids: before.prompts.map((prompt) => prompt.id),
      expectedOrderVersion: before.orderVersion,
    }),
  ).toThrow(PromptOrderConflictError);
  expect(first.prompts.reorder({ ids, expectedOrderVersion: saved.orderVersion })).toEqual(saved);
  second.prompts.update("personality", { content: "Facts about the owner.\n", expectedVersion: 1 });
  expect(second.prompts.catalog().orderVersion).toBe(saved.orderVersion);
  first.store.close();
  stores.splice(stores.indexOf(first.store), 1);
  const reopened = setup(path);
  expect(reopened.prompts.catalog().prompts.map((prompt) => prompt.id)).toEqual(ids);
  expect(reopened.prompts.catalog().orderVersion).toBe(saved.orderVersion);
  expect(reopened.prompts.get("personality")?.content).toBe("Facts about the owner.\n");
});

test("invalid permutations and attempts to move after-history cannot mutate order", () => {
  const { prompts, characters } = setup();
  characters.import(card, importOptions);
  const before = prompts.catalog();
  const ids = before.prompts.map((prompt) => prompt.id);
  for (const candidate of [
    [...ids, ids[0] ?? ""],
    [ids.at(-1) ?? "", ...ids.slice(0, -1)],
  ]) {
    expect(() =>
      prompts.reorder({ ids: candidate, expectedOrderVersion: before.orderVersion }),
    ).toThrow(PromptOrderValidationError);
  }
  for (const candidate of [ids.slice(1), [...ids.slice(0, -1), "unknown"]]) {
    expect(() =>
      prompts.reorder({ ids: candidate, expectedOrderVersion: before.orderVersion }),
    ).toThrow(PromptOrderConflictError);
  }
  expect(prompts.catalog()).toEqual(before);
});

test("imports append new sections before the pinned final section and invalidate old catalog versions", () => {
  const { prompts, characters, store } = setup();
  const before = prompts.catalog();
  const ids = before.prompts.map((prompt) => prompt.id).reverse();
  const reordered = prompts.reorder({ ids, expectedOrderVersion: before.orderVersion });
  const imported = characters.import(card, importOptions);
  const after = prompts.catalog();
  expect(after.orderVersion).toBe(reordered.orderVersion + 1);
  expect(after.prompts.slice(0, ids.length).map((prompt) => prompt.id)).toEqual(ids);
  expect(after.prompts.at(-1)?.id).toBe("character.post-history");
  expect(() => prompts.reorder({ ids, expectedOrderVersion: reordered.orderVersion })).toThrow(
    PromptOrderConflictError,
  );
  characters.import(card, { ...importOptions, expectedActiveImportId: imported.character.id });
  expect(createPromptService(store).catalog()).toEqual(after);
});

test("import failure rolls prompt ordering back with the rest of the import", () => {
  const { prompts, characters, store } = setup();
  const before = prompts.catalog();
  store.db.exec(`CREATE TRIGGER reject_order_import BEFORE INSERT ON core_activity
    WHEN NEW.kind = 'character.import' BEGIN SELECT RAISE(ABORT, 'Injected failure'); END;`);
  expect(() => characters.import(card, importOptions)).toThrow("Injected failure");
  expect(prompts.catalog()).toEqual(before);
});
