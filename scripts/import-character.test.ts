import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCharacterService, createPromptService, openStore } from "@valerie/core";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

test("import CLI backs up existing state, verifies source, and preserves later edits on replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "valerie-import-cli-"));
  directories.push(directory);
  const database = join(directory, "private.sqlite");
  const source = join(directory, "fictional.json");
  const json = JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "Fictional character",
      description: "  Original fixture.\n",
      extensions: { preserved: [1, 2] },
    },
  });
  writeFileSync(source, json);
  const original = openStore(database);
  createPromptService(original).update("voice", {
    content: "Existing optional overlay.",
    expectedVersion: 1,
  });
  original.close();
  const run = () =>
    Bun.spawnSync([process.execPath, "scripts/import-character.ts", source], {
      cwd: resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", VALERIE_DATABASE: database, VALERIE_HOST: "127.0.0.1" },
      stdout: "pipe",
      stderr: "pipe",
    });
  const first = run();
  expect(first.exitCode).toBe(0);
  const report = JSON.parse(first.stdout.toString());
  expect(report.importedNow).toBe(true);
  expect(report.originalBytesVerified).toBe(true);
  expect(report.authoredFieldsVerifiedAfterReopen).toBe(true);
  expect(readFileSync(source, "utf8")).toBe(json);
  expect(
    readFileSync(
      join(directory, "character-imports", report.character.sha256, "card.json"),
      "utf8",
    ),
  ).toBe(json);
  const backup = new Database(report.backup, { readonly: true });
  expect(backup.query("SELECT content FROM core_prompts WHERE id = 'voice'").get()).toEqual({
    content: "Existing optional overlay.",
  });
  backup.close();
  const reopened = openStore(database);
  const prompts = createPromptService(reopened);
  expect(createCharacterService(reopened).getActive()?.id).toBe(report.character.id);
  const description = prompts.get("character.description");
  if (!description) throw new Error("Missing imported description");
  prompts.update(description.id, {
    content: "A later user edit.",
    expectedVersion: description.version,
  });
  reopened.close();
  const second = run();
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(second.stdout.toString()).importedNow).toBe(false);
  const final = openStore(database);
  expect(createPromptService(final).get("character.description")?.content).toBe(
    "A later user edit.",
  );
  expect(createPromptService(final).get("voice")?.content).toBe("Existing optional overlay.");
  final.close();
  expect(readdirSync(join(directory, "backups"))).toHaveLength(2);
});
