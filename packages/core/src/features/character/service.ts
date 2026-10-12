import { isRecord } from "../../guards";
import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { synchronizePromptOrder } from "../prompts/order";
import { MAX_PROMPT_BYTES } from "../prompts/service";
import {
  type CharacterPromptPlacement,
  type CharacterSourceField,
  characterMappings,
} from "./mappings";
import { CharacterCardError, type CharacterCardPreview, parseCharacterCard } from "./parse";

export interface CharacterFieldMapping {
  sourceField: CharacterSourceField;
  promptId: string;
  placement: CharacterPromptPlacement;
  sourcePresent: boolean;
  utf8Bytes: number;
}

export interface CharacterPreservedOnly {
  /** Known source fields only; arbitrary extension names and values remain private. */
  fieldPaths: string[];
  unknownFieldCount: number;
  extensionCount: number;
  lorebookEntries: number;
  alternateGreetings: number;
  macrosExpanded: false;
}

export interface CharacterImportMetadata {
  id: string;
  sha256: string;
  sourceName: string | null;
  displayName: string;
  sourceFilename: string;
  importedAt: string;
  format: CharacterCardPreview["format"];
  metadataKeyword: CharacterCardPreview["metadataKeyword"];
  mappings: CharacterFieldMapping[];
  preservedOnly: CharacterPreservedOnly;
}

export interface CharacterImportInput {
  sourceFilename: string;
  displayName?: string;
  expectedActiveImportId: string | null;
}

export interface CharacterImportResult {
  character: CharacterImportMetadata;
  /** False for the exact active source; repeat imports never reset edited prompts. */
  imported: boolean;
}

export class CharacterImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterImportConflictError";
  }
}

interface CharacterImportRow extends Omit<CharacterImportMetadata, "mappings" | "preservedOnly"> {
  mappingsJson: string;
  preservedOnlyJson: string;
}

function metadata(row: CharacterImportRow): CharacterImportMetadata {
  const { mappingsJson, preservedOnlyJson, ...values } = row;
  return {
    ...values,
    mappings: JSON.parse(mappingsJson) as CharacterFieldMapping[],
    preservedOnly: JSON.parse(preservedOnlyJson) as CharacterPreservedOnly,
  };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function preservedOnly(preview: CharacterCardPreview): CharacterPreservedOnly {
  const wrapped = preview.card.spec !== undefined;
  const data = wrapped && isRecord(preview.card.data) ? preview.card.data : preview.card;
  const prefix = wrapped ? "data." : "";
  const preserved = [
    "name",
    "first_mes",
    "creator_notes",
    "character_book",
    "alternate_greetings",
    "extensions",
    "tags",
    "creator",
    "character_version",
    "assets",
    "group_only_greetings",
  ];
  const knownFields = new Set<string>([
    ...preserved,
    ...characterMappings.map((mapping) => mapping.sourceField),
  ]);
  const book = data.character_book;
  const extensions = data.extensions;
  return {
    fieldPaths: preserved.filter((key) => key in data).map((key) => `${prefix}${key}`),
    unknownFieldCount:
      Object.keys(data).filter((key) => !knownFields.has(key)).length +
      (wrapped
        ? Object.keys(preview.card).filter((key) => !["spec", "spec_version", "data"].includes(key))
            .length
        : 0),
    extensionCount: isRecord(extensions) ? Object.keys(extensions).length : 0,
    lorebookEntries: isRecord(book) && Array.isArray(book.entries) ? book.entries.length : 0,
    alternateGreetings: Array.isArray(data.alternate_greetings)
      ? data.alternate_greetings.length
      : 0,
    macrosExpanded: false,
  };
}

export function createCharacterService(store: Store) {
  const { db } = store;
  const activity = createActivityService(store);
  const active = db.query<CharacterImportRow, []>(`
    SELECT source.id, source.sha256, source.source_name AS sourceName,
      source.display_name AS displayName, source.source_filename AS sourceFilename,
      source.imported_at AS importedAt, source.format, source.metadata_keyword AS metadataKeyword,
      source.mappings_json AS mappingsJson, source.preserved_only_json AS preservedOnlyJson
    FROM core_character_imports AS source
    JOIN core_character_active AS active ON active.import_id = source.id
    WHERE active.singleton = 1
  `);
  const getActive = (): CharacterImportMetadata | null => {
    const row = active.get();
    return row ? metadata(row) : null;
  };

  return {
    getActive,
    import(source: Uint8Array, input: CharacterImportInput): CharacterImportResult {
      if (
        typeof input.sourceFilename !== "string" ||
        !input.sourceFilename.trim() ||
        /[/\\]/.test(input.sourceFilename) ||
        hasControlCharacters(input.sourceFilename) ||
        Buffer.byteLength(input.sourceFilename, "utf8") > 255
      ) {
        throw new TypeError(
          "A source filename without directories, of at most 255 bytes, is required.",
        );
      }
      const displayName = input.displayName ?? "Valerie";
      if (
        typeof displayName !== "string" ||
        !displayName.trim() ||
        hasControlCharacters(displayName) ||
        Buffer.byteLength(displayName, "utf8") > 120
      ) {
        throw new TypeError(
          "A display name of at most 120 bytes without control characters is required.",
        );
      }
      if (
        input.expectedActiveImportId !== null &&
        (typeof input.expectedActiveImportId !== "string" || !input.expectedActiveImportId)
      ) {
        throw new TypeError("The expected active import ID or null is required.");
      }
      const preview = parseCharacterCard(source);
      const mappings: CharacterFieldMapping[] = characterMappings.map((mapping) => {
        const content = preview.fields[mapping.sourceField];
        const utf8Bytes = Buffer.byteLength(content ?? "", "utf8");
        if (utf8Bytes > MAX_PROMPT_BYTES) {
          throw new CharacterCardError(
            `Character field '${mapping.sourceField}' exceeds the 256 KiB prompt limit.`,
          );
        }
        return {
          sourceField: mapping.sourceField,
          promptId: mapping.promptId,
          placement: mapping.placement,
          sourcePresent: content !== undefined,
          utf8Bytes,
        };
      });
      return db
        .transaction(() => {
          const current = getActive();
          if ((current?.id ?? null) !== input.expectedActiveImportId) {
            throw new CharacterImportConflictError(
              "The active character changed. Reload its current import ID before importing.",
            );
          }
          if (current) {
            if (current.sha256 === preview.sha256) return { character: current, imported: false };
            throw new CharacterImportConflictError(
              "A different character source is already active. Replacement requires an explicit replacement workflow.",
            );
          }
          const character: CharacterImportMetadata = {
            id: crypto.randomUUID(),
            sha256: preview.sha256,
            sourceName: preview.fields.name ?? null,
            displayName,
            sourceFilename: input.sourceFilename,
            importedAt: new Date().toISOString(),
            format: preview.format,
            metadataKeyword: preview.metadataKeyword,
            mappings,
            preservedOnly: preservedOnly(preview),
          };
          // Check every destination first, including absent/empty source fields. Imported
          // definitions cannot silently replace edits that were made before activation.
          const existing = db.query<{ content: string; version: number }, [string]>(
            "SELECT content, version FROM core_prompts WHERE id = ?",
          );
          for (const mapping of characterMappings) {
            if (existing.get(mapping.promptId)?.content) {
              throw new CharacterImportConflictError(
                `Prompt '${mapping.promptId}' already contains authored content. Import cannot overwrite it.`,
              );
            }
          }
          db.query(`
          INSERT INTO core_character_imports
            (id, sha256, original_bytes, json_text, source_name, display_name, source_filename,
             imported_at, format, metadata_keyword, mappings_json, preserved_only_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            character.id,
            character.sha256,
            preview.originalBytes,
            preview.jsonText,
            character.sourceName,
            character.displayName,
            character.sourceFilename,
            character.importedAt,
            character.format,
            character.metadataKeyword,
            JSON.stringify(character.mappings),
            JSON.stringify(character.preservedOnly),
          );
          for (const mapping of characterMappings) {
            const content = preview.fields[mapping.sourceField] ?? "";
            const version = (existing.get(mapping.promptId)?.version ?? 0) + 1;
            db.query(`
            INSERT INTO core_prompts (id, title, purpose, content, version, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET title = excluded.title, purpose = excluded.purpose,
              content = excluded.content, version = excluded.version, updated_at = excluded.updated_at
          `).run(
              mapping.promptId,
              mapping.title,
              mapping.purpose,
              content,
              version,
              character.importedAt,
            );
            db.query(`
            INSERT INTO core_prompt_revisions (prompt_id, version, content, created_at)
            VALUES (?, ?, ?, ?)
          `).run(mapping.promptId, version, content, character.importedAt);
          }
          synchronizePromptOrder(db);
          db.query("INSERT INTO core_character_active (singleton, import_id) VALUES (1, ?)").run(
            character.id,
          );
          activity.append({
            kind: "character.import",
            summary: `Character source preserved; ${mappings.filter((mapping) => mapping.sourcePresent).length} authored fields imported.`,
            metadata: { importId: character.id, sha256: character.sha256 },
          });
          return { character, imported: true };
        })
        .immediate();
    },
    /** Local-only fidelity verification; never expose original private assets through HTTP. */
    getOriginal(id: string): { originalBytes: Uint8Array; jsonText: string } | undefined {
      const original = db
        .query<{ originalBytes: Uint8Array; jsonText: string }, [string]>(`
          SELECT original_bytes AS originalBytes, json_text AS jsonText
          FROM core_character_imports WHERE id = ?
        `)
        .get(id);
      return original
        ? { originalBytes: new Uint8Array(original.originalBytes), jsonText: original.jsonText }
        : undefined;
    },
  };
}

export type CharacterService = ReturnType<typeof createCharacterService>;
