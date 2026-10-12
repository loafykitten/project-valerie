import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CharacterCardError,
  CharacterImportConflictError,
  createActivityService,
  createCharacterService,
  createPromptService,
  openStore,
  type Store,
} from "../src";

const stores: Store[] = [];
const directories: string[] = [];
function setup(path = ":memory:") {
  const store = openStore(path);
  stores.push(store);
  return {
    store,
    prompts: createPromptService(store),
    characters: createCharacterService(store),
    activity: createActivityService(store),
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// Fictional prose only. Whitespace, macros and unknown fields are fidelity evidence.
const fields = {
  name: "Source character",
  description: "  Description for {{char}}.\r\nKeep this whitespace. 💜\n",
  personality: "Curious and patient.",
  scenario: "An observatory at night.",
  first_mes: "UNSENT_GREETING *waves*",
  mes_example: "<START>\n{{user}}: Hello.\n{{char}}: *smiles* Hi there.\n",
  creator_notes: "PRIVATE_CREATOR_NOTE",
  system_prompt: "Fictional source instructions.",
  post_history_instructions: "POST_HISTORY_ONLY {{original}}\n",
};
const raw = JSON.stringify(
  {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      ...fields,
      alternate_greetings: ["Other greeting."],
      character_book: { entries: [{ keys: ["star"], content: "CONDITIONAL_LORE", enabled: true }] },
      extensions: { "private-extension-key": { depth_prompt: "PRESERVED_EXTENSION" } },
      unknownDataField: { numbers: [42, 9] },
    },
    unknownRootField: "PRESERVED_ROOT",
  },
  null,
  2,
);
const options = { sourceFilename: "fictional-card.json", expectedActiveImportId: null } as const;

describe("durable, faithful character import", () => {
  test("preserves exact bytes/JSON and unknown fields, with independent source/display names", () => {
    const { characters, prompts, activity, store } = setup();
    const source = new Uint8Array(Buffer.from(raw));
    const { character, imported } = characters.import(source, options);
    expect(imported).toBe(true);
    expect(character.sourceName).toBe(fields.name);
    expect(character.displayName).toBe("Valerie");
    expect(character.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(character.mappings).toHaveLength(6);
    expect(character.preservedOnly).toEqual({
      fieldPaths: [
        "data.name",
        "data.first_mes",
        "data.creator_notes",
        "data.character_book",
        "data.alternate_greetings",
        "data.extensions",
      ],
      unknownFieldCount: 2,
      extensionCount: 1,
      lorebookEntries: 1,
      alternateGreetings: 1,
      macrosExpanded: false,
    });
    expect(JSON.stringify(character)).not.toContain(fields.description);
    expect(JSON.stringify(character)).not.toContain("private-extension-key");
    const original = characters.getOriginal(character.id);
    expect(original?.jsonText).toBe(raw);
    expect(original?.originalBytes).toEqual(source);
    source.fill(0);
    original?.originalBytes.fill(0);
    expect(characters.getOriginal(character.id)?.originalBytes).toEqual(
      new Uint8Array(Buffer.from(raw)),
    );
    expect(characters.getOriginal("missing")).toBeUndefined();
    expect(prompts.get("identity")?.content).toBe("Your name is Valerie.");
    for (const id of ["personality", "relationship", "voice"])
      expect(prompts.get(id)?.content).toBe("");
    for (const mapping of character.mappings) {
      expect(prompts.get(mapping.promptId)?.content).toBe(fields[mapping.sourceField]);
      expect(prompts.history(mapping.promptId)).toHaveLength(1);
      expect(mapping.sourcePresent).toBe(true);
      expect(mapping.utf8Bytes).toBe(Buffer.byteLength(fields[mapping.sourceField], "utf8"));
    }
    expect(prompts.list().at(-1)?.id).toBe("character.post-history");
    expect(
      prompts
        .list()
        .slice(0, 16)
        .map((prompt) => prompt.id),
    ).toEqual([
      "identity",
      "personality",
      "conversation-context",
      "memory-direction",
      "relationship",
      "voice",
      "channel.telegram-text",
      "channel.telegram-voice",
      "image-generation",
      "growth-focus",
      "daily-records",
      "habits",
      "rules",
      "reflection",
      "heartbeat",
      "reminders",
    ]);
    expect(prompts.list()).toHaveLength(22);
    expect(prompts.get("character.first-message")).toBeUndefined();
    expect(prompts.get("character.creator-notes")).toBeUndefined();
    expect(activity.list()).toHaveLength(1);
    expect(JSON.stringify(activity.list())).not.toContain(fields.description);
    expect(() =>
      store.db
        .query("UPDATE core_character_imports SET json_text = '{}' WHERE id = ?")
        .run(character.id),
    ).toThrow("immutable");
    expect(() =>
      store.db.query("DELETE FROM core_character_imports WHERE id = ?").run(character.id),
    ).toThrow("immutable");
  });

  test("catalog refresh retires reference sections while preserving authored prompts and source history", () => {
    const { characters, prompts, store } = setup();
    const { character } = characters.import(Buffer.from(raw), options);
    const retired = ["character.first-message", "character.creator-notes"];
    for (const id of retired) {
      store.db
        .query(`INSERT INTO core_prompts (id, title, purpose, content, version, updated_at)
        VALUES (?, 'Old reference', 'Old description', 'A later reference edit', 2, '2026-09-12')`)
        .run(id);
      for (const version of [1, 2]) {
        store.db
          .query(`INSERT INTO core_prompt_revisions (prompt_id, version, content, created_at)
          VALUES (?, ?, 'Saved reference', '2026-09-12')`)
          .run(id, version);
      }
    }
    prompts.update("character.description", {
      content: "  Owner's exact words.\n",
      expectedVersion: 1,
    });
    prompts.update("relationship", { content: "Personal boundaries.\n", expectedVersion: 1 });
    const saved = prompts.list().filter((prompt) => !retired.includes(prompt.id));
    const history = Object.fromEntries(
      saved.map((prompt) => [prompt.id, prompts.history(prompt.id)]),
    );
    const original = characters.getOriginal(character.id);
    store.db.exec(
      "UPDATE core_prompts SET title = 'Old title imported', purpose = 'Empty until supplied'",
    );

    for (let activation = 0; activation < 2; activation++) {
      const refreshed = createPromptService(store);
      expect(refreshed.list()).toHaveLength(22);
      for (const prior of saved) {
        expect(refreshed.get(prior.id)).toEqual(prior);
        expect(refreshed.history(prior.id)).toEqual(history[prior.id] ?? []);
      }
      for (const id of retired) {
        expect(refreshed.get(id)).toBeUndefined();
        expect(() => refreshed.update(id, { content: "Recreate", expectedVersion: 2 })).toThrow(
          "does not exist",
        );
        expect(() => refreshed.history(id)).toThrow("does not exist");
        expect(
          store.db
            .query("SELECT count(*) AS count FROM core_prompt_revisions WHERE prompt_id = ?")
            .get(id),
        ).toEqual({ count: 0 });
      }
      expect(characters.getOriginal(character.id)).toEqual(original);
      expect(characters.getActive()).toEqual(character);
      expect(
        characters.import(Buffer.from(raw), { ...options, expectedActiveImportId: character.id })
          .imported,
      ).toBe(false);
      expect(refreshed.list()).toHaveLength(22);
    }
    expect(store.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("repeat import is idempotent without resetting edited prompts; stale or different sources reject", () => {
    const { characters, prompts, activity } = setup();
    const { character } = characters.import(Buffer.from(raw), options);
    prompts.update("character.description", { content: "Owner's later edit.", expectedVersion: 1 });
    const repeat = characters.import(Buffer.from(raw), {
      ...options,
      expectedActiveImportId: character.id,
    });
    expect(repeat).toEqual({ imported: false, character });
    expect(prompts.get("character.description")?.content).toBe("Owner's later edit.");
    expect(prompts.history("character.description")).toHaveLength(2);
    expect(prompts.list()).toHaveLength(22);
    expect(prompts.get("character.first-message")).toBeUndefined();
    expect(prompts.get("character.creator-notes")).toBeUndefined();
    expect(activity.list()).toHaveLength(1);
    expect(() => characters.import(Buffer.from(raw), options)).toThrow(
      CharacterImportConflictError,
    );
    expect(() =>
      characters.import(Buffer.from('{"description":"Other source"}'), {
        ...options,
        expectedActiveImportId: character.id,
      }),
    ).toThrow("Replacement requires");
    expect(characters.getActive()).toEqual(character);
  });

  test("preexisting destination content blocks the entire import and preserves all prior edits", () => {
    const { characters, prompts, activity, store } = setup();
    store.db
      .query(`INSERT INTO core_prompts (id, title, purpose, content, version, updated_at)
      VALUES ('character.examples', 'Existing', 'Existing', 'Do not replace', 1, '2026-09-12')`)
      .run();
    prompts.update("relationship", { content: "Owner-authored overlay.", expectedVersion: 1 });
    expect(() => characters.import(Buffer.from(raw), options)).toThrow("cannot overwrite");
    expect(characters.getActive()).toBeNull();
    expect(prompts.get("character.examples")?.content).toBe("Do not replace");
    expect(prompts.get("character.description")).toBeUndefined();
    expect(prompts.get("relationship")?.content).toBe("Owner-authored overlay.");
    expect(activity.list()).toHaveLength(0);
    expect(store.db.query("SELECT count(*) AS count FROM core_character_imports").get()).toEqual({
      count: 0,
    });
  });

  test("a failure after prompt writes rolls back original, prompts, active source, and activity together", () => {
    const { characters, prompts, activity, store } = setup();
    store.db.exec(`CREATE TRIGGER reject_character_activity BEFORE INSERT ON core_activity
      WHEN NEW.kind = 'character.import' BEGIN SELECT RAISE(ABORT, 'Injected failure'); END;`);
    expect(() => characters.import(Buffer.from(raw), options)).toThrow("Injected failure");
    expect(characters.getActive()).toBeNull();
    expect(prompts.list()).toHaveLength(16);
    expect(activity.list()).toHaveLength(0);
    expect(store.db.query("SELECT count(*) AS count FROM core_character_imports").get()).toEqual({
      count: 0,
    });
    expect(
      store.db
        .query(
          "SELECT count(*) AS count FROM core_prompt_revisions WHERE prompt_id LIKE 'character.%'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  test("reopening and a second connection retain the source and reject a stale initial import", () => {
    const directory = mkdtempSync(join(tmpdir(), "valerie-character-"));
    directories.push(directory);
    const path = join(directory, "valerie.sqlite");
    const first = setup(path);
    const second = setup(path);
    expect(second.characters.getActive()).toBeNull();
    const { character } = first.characters.import(Buffer.from(raw), options);
    expect(second.characters.getActive()).toEqual(character);
    expect(() => second.characters.import(Buffer.from(raw), options)).toThrow(
      CharacterImportConflictError,
    );
    first.store.close();
    stores.splice(stores.indexOf(first.store), 1);
    const reopened = setup(path);
    expect(reopened.characters.getActive()).toEqual(character);
    expect(reopened.characters.getOriginal(character.id)?.jsonText).toBe(raw);
    expect(reopened.characters.getOriginal(character.id)?.originalBytes).toEqual(
      new Uint8Array(Buffer.from(raw)),
    );
    expect(reopened.prompts.get("character.description")?.content).toBe(fields.description);
    expect(reopened.prompts.history("character.description")).toHaveLength(1);
  });

  test("invalid or oversized fields do not create partial state; absent fields remain empty", () => {
    const { characters, prompts } = setup();
    expect(() => characters.import(Buffer.from('{"description":42}'), options)).toThrow(
      CharacterCardError,
    );
    expect(() =>
      characters.import(
        Buffer.from(JSON.stringify({ description: "x".repeat(256 * 1024 + 1) })),
        options,
      ),
    ).toThrow("256 KiB");
    expect(() =>
      characters.import(Buffer.from(raw), { ...options, sourceFilename: "/private/card.png" }),
    ).toThrow(TypeError);
    expect(characters.getActive()).toBeNull();
    expect(prompts.list()).toHaveLength(16);
    const { character } = characters.import(
      Buffer.from('{"description":"Only description"}'),
      options,
    );
    expect(character.sourceName).toBeNull();
    expect(
      character.mappings.find((mapping) => mapping.sourceField === "scenario")?.sourcePresent,
    ).toBe(false);
    expect(prompts.get("character.scenario")?.content).toBe("");
  });
});

describe("imported character prompt snapshots", () => {
  test("separates prefix, text-only examples, and after-history instructions without evaluating metadata", () => {
    const { characters, prompts } = setup();
    const { character } = characters.import(Buffer.from(raw), options);
    const text = prompts.compose("telegram-text");
    expect(text.characterImportId).toBe(character.id);
    for (const value of [
      fields.description,
      fields.personality,
      fields.scenario,
      fields.system_prompt,
      fields.mes_example,
    ]) {
      expect(text.content).toContain(value);
    }
    expect(text.postHistoryContent).toBe(
      `# Post-History Instructions\n\n${fields.post_history_instructions}`,
    );
    expect(text.postHistoryPlacement).toBe("after-history");
    expect(text.placements["character.post-history"]).toBe("after-history");
    expect(text.placements["character.examples"]).toBe("telegram-text-example");
    expect(text.versions["character.post-history"]).toBe(1);
    expect(text.versions["character.examples"]).toBe(1);
    for (const excluded of [
      fields.post_history_instructions,
      fields.first_mes,
      fields.creator_notes,
      "CONDITIONAL_LORE",
      "PRESERVED_EXTENSION",
      "PRESERVED_ROOT",
    ])
      expect(text.content).not.toContain(excluded);
    for (const channel of ["telegram-voice", "desktop-voice"] as const) {
      const snapshot = prompts.compose(channel);
      expect(snapshot.content).not.toContain(fields.mes_example);
      expect(snapshot.content).not.toContain(fields.first_mes);
      expect(snapshot.content).toContain(fields.description);
      expect(snapshot.postHistoryContent).toBe(
        `# Post-History Instructions\n\n${fields.post_history_instructions}`,
      );
      expect(snapshot.versions["character.examples"]).toBeUndefined();
      expect(snapshot.versions["character.post-history"]).toBe(1);
    }
    prompts.update("character.post-history", {
      content: "New after-history instructions.",
      expectedVersion: 1,
    });
    prompts.update("character.description", { content: "New description.", expectedVersion: 1 });
    const next = prompts.compose("telegram-text");
    expect(next.content).toContain("New description.");
    expect(next.postHistoryContent).toBe(
      "# Post-History Instructions\n\nNew after-history instructions.",
    );
    expect(next.versions["character.description"]).toBe(2);
    expect(next.versions["character.post-history"]).toBe(2);
    expect(text.content).toContain(fields.description);
    expect(text.postHistoryContent).toBe(
      `# Post-History Instructions\n\n${fields.post_history_instructions}`,
    );
    expect(text.versions["character.post-history"]).toBe(1);
  });
});
