import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  createCharacterService,
  createPromptService,
  openStore,
  parseCharacterCard,
} from "@valerie/core";
import { loadConfig } from "../apps/server/src/config";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let committed = false;

function preserveFile(path: string, bytes: Uint8Array | string) {
  if (existsSync(path)) {
    if (hash(readFileSync(path)) !== hash(bytes)) throw new Error("Preserved file differs");
    return;
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("Missing source path");
  process.umask(0o077);
  const source = Bun.file(path);
  if (!source.size || source.size > 16 * 1024 * 1024) throw new Error("Invalid file size");
  const preview = parseCharacterCard(new Uint8Array(await source.arrayBuffer()));
  const database = resolve(loadConfig().database);
  let backup: string | null = null;
  if (existsSync(database)) {
    const directory = join(dirname(database), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    backup = join(directory, `before-character-import-${Date.now()}-${crypto.randomUUID()}.sqlite`);
    const previous = new Database(database, { readonly: true });
    try {
      // VACUUM INTO makes a standalone backup, including committed WAL content.
      previous.exec("PRAGMA busy_timeout = 5000");
      previous.query("VACUUM INTO ?").run(backup);
    } finally {
      previous.close();
    }
    const check = new Database(backup, { readonly: true });
    try {
      const result = check.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
      if (result?.quick_check !== "ok") throw new Error("Backup verification failed");
    } finally {
      check.close();
    }
  }
  const store = openStore(database);
  let result: ReturnType<ReturnType<typeof createCharacterService>["import"]>;
  try {
    const characters = createCharacterService(store);
    result = characters.import(preview.originalBytes, {
      sourceFilename: basename(path),
      displayName: "Valerie",
      expectedActiveImportId: characters.getActive()?.id ?? null,
    });
    committed = result.imported;
  } finally {
    store.close();
  }

  const reopened = openStore(database);
  try {
    const characters = createCharacterService(reopened);
    const original = characters.getOriginal(result.character.id);
    if (
      !original ||
      hash(original.originalBytes) !== preview.sha256 ||
      original.jsonText !== preview.jsonText
    ) {
      throw new Error("Original source verification failed");
    }
    if (result.imported) {
      const prompts = createPromptService(reopened);
      for (const mapping of result.character.mappings) {
        if (
          mapping.sourcePresent &&
          prompts.get(mapping.promptId)?.content !==
            preview.fields[mapping.sourceField as keyof typeof preview.fields]
        ) {
          throw new Error("Mapped field verification failed");
        }
      }
    }
    const directory = join(dirname(database), "character-imports", preview.sha256);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    preserveFile(
      join(directory, preview.format === "png" ? "original.png" : "original.json"),
      original.originalBytes,
    );
    preserveFile(join(directory, "card.json"), original.jsonText);
    const report = {
      character: result.character,
      importedNow: result.imported,
      originalBytesVerified: true,
      authoredFieldsVerifiedAfterReopen: result.imported,
      sourceUnchanged: hash(new Uint8Array(await source.arrayBuffer())) === preview.sha256,
      backup,
      note: "Authored text and unknown extensions are preserved. Macros, lorebook activation, and YuriOS runtime behavior are not executed by this import. Existing optional overlays are unchanged.",
    };
    const reportPath = join(directory, `verification-${Date.now()}.json`);
    preserveFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.info(JSON.stringify({ ...report, reportPath }, null, 2));
  } finally {
    reopened.close();
  }
} catch {
  console.error(
    committed
      ? "The character import was saved, but its follow-up verification or private export failed. Check the local database and backup before retrying."
      : "Character import did not complete. Use one readable PNG/JSON path; existing imported characters and nonempty source prompts are protected from replacement.",
  );
  process.exitCode = 1;
}
