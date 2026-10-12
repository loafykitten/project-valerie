import type { Database } from "bun:sqlite";
import { characterMappings } from "../character/mappings";
import { promptSeeds } from "./seeds";

export const POST_HISTORY_ID = "character.post-history";
const defaultIds = [
  "identity",
  ...characterMappings.map((mapping) => mapping.promptId),
  ...promptSeeds.filter((prompt) => prompt.id !== "identity").map((prompt) => prompt.id),
];

export function readPromptOrder(db: Database): { ids: string[]; version: number } {
  const row = db
    .query<{ idsJson: string; version: number }, []>(
      "SELECT ids_json AS idsJson, version FROM core_prompt_order WHERE singleton = 1",
    )
    .get();
  if (!row) throw new Error("Prompt order is not initialized. Restart to apply migrations.");
  const ids: unknown = JSON.parse(row.idsJson);
  if (
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === "string") ||
    new Set(ids).size !== ids.length
  )
    throw new Error("Stored prompt order is invalid.");
  return { ids, version: row.version };
}

/** Preserve existing order, append new catalog entries, and always pin after-history last. */
export function orderedPromptIds(available: string[], stored: string[]): string[] {
  const present = new Set(available);
  const ids = [...new Set([...stored, ...defaultIds, ...available.slice().sort()])].filter(
    (id) => present.has(id) && id !== POST_HISTORY_ID,
  );
  // Place new conversation guidance beside owner knowledge once. Subsequent owner
  // reordering is preserved, as is the relative order of every existing section.
  for (const [id, anchor] of [
    ["conversation-context", "personality"],
    ["memory-direction", "conversation-context"],
  ] as const) {
    if (stored.includes(id) || !ids.includes(id) || !ids.includes(anchor)) continue;
    ids.splice(ids.indexOf(id), 1);
    ids.splice(ids.indexOf(anchor) + 1, 0, id);
  }
  if (present.has(POST_HISTORY_ID)) ids.push(POST_HISTORY_ID);
  return ids;
}

/** Call inside the catalog/import write transaction, never while composing a turn. */
export function synchronizePromptOrder(db: Database, initialize = false): void {
  const previous = readPromptOrder(db);
  // A CLI import may precede prompt seeding. Let service initialization capture the full catalog.
  if (!initialize && previous.ids.length === 0) return;
  const available = db
    .query<{ id: string }, []>("SELECT id FROM core_prompts")
    .all()
    .map(({ id }) => id);
  const ids = orderedPromptIds(available, previous.ids);
  if (JSON.stringify(ids) === JSON.stringify(previous.ids)) return;
  db.query(
    "UPDATE core_prompt_order SET ids_json = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
  ).run(JSON.stringify(ids), new Date().toISOString());
}
