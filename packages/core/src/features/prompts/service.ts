import type { Store } from "../../store";
import { characterMappings, retiredCharacterPromptIds } from "../character/mappings";
import {
  orderedPromptIds,
  POST_HISTORY_ID,
  readPromptOrder,
  synchronizePromptOrder,
} from "./order";
import { promptSeeds } from "./seeds";

export const communicationChannels = ["telegram-text", "telegram-voice", "desktop-voice"] as const;
export type CommunicationChannel = (typeof communicationChannels)[number];

export interface Prompt {
  id: string;
  title: string;
  purpose: string;
  content: string;
  version: number;
  updatedAt: string;
}

export interface PromptCatalog {
  prompts: Prompt[];
  orderVersion: number;
}

export class PromptOrderConflictError extends Error {
  constructor() {
    super("The prompt order or available sections changed. Reload before reordering.");
    this.name = "PromptOrderConflictError";
  }
}

export class PromptOrderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptOrderValidationError";
  }
}

export interface PromptRevision {
  promptId: string;
  version: number;
  content: string;
  createdAt: string;
}

export interface PromptSnapshot {
  channel: CommunicationChannel;
  orderVersion: number;
  /** Ordered system sections, each separated by its title as a Markdown H1. */
  content: string;
  /** Separate instructions for after conversation history, never part of the prefix. */
  postHistoryContent: string;
  postHistoryPlacement: "after-history";
  characterImportId: string | null;
  /** Includes empty prompts, making omissions and version provenance visible. */
  prompts: Prompt[];
  versions: Record<string, number>;
  placements: Record<string, "system" | "telegram-text-example" | "after-history">;
}

export class PromptNotFoundError extends Error {
  constructor(readonly promptId: string) {
    super(`Prompt '${promptId}' does not exist.`);
    this.name = "PromptNotFoundError";
  }
}

export class PromptConflictError extends Error {
  constructor(
    readonly promptId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `Prompt '${promptId}' changed since it was loaded. Reload version ${currentVersion} before saving.`,
    );
    this.name = "PromptConflictError";
  }
}

const columns = "id, title, purpose, content, version, updated_at AS updatedAt";
export const MAX_PROMPT_BYTES = 256 * 1024;

export function createPromptService({ db }: Store) {
  // Reconcile the catalog on startup and hot activation without rewriting authored content.
  db.transaction(() => {
    const now = new Date().toISOString();
    const insert = db.query(`
      INSERT OR IGNORE INTO core_prompts (id, title, purpose, content, version, updated_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    const insertRevision = db.query(`
      INSERT INTO core_prompt_revisions (prompt_id, version, content, created_at)
      VALUES (?, 1, ?, ?)
    `);
    // These two reference sections were explicitly removed by the owner. Delete their
    // revisions first for the foreign key; immutable character sources remain untouched.
    for (const id of retiredCharacterPromptIds) {
      db.query("DELETE FROM core_prompt_revisions WHERE prompt_id = ?").run(id);
      db.query("DELETE FROM core_prompts WHERE id = ?").run(id);
    }
    for (const seed of promptSeeds) {
      if (insert.run(seed.id, seed.title, seed.purpose, seed.content, now).changes) {
        insertRevision.run(seed.id, seed.content, now);
      }
    }
    const updateMetadata = db.query(
      "UPDATE core_prompts SET title = ?, purpose = ? WHERE id = ? AND (title != ? OR purpose != ?)",
    );
    for (const definition of [
      ...promptSeeds,
      ...characterMappings.map(({ promptId, title, purpose }) => ({
        id: promptId,
        title,
        purpose,
      })),
    ]) {
      updateMetadata.run(
        definition.title,
        definition.purpose,
        definition.id,
        definition.title,
        definition.purpose,
      );
    }
    synchronizePromptOrder(db, true);
  }).immediate();

  const catalog = (): PromptCatalog =>
    db.transaction(() => {
      const rows = db.query<Prompt, []>(`SELECT ${columns} FROM core_prompts`).all();
      const byId = new Map(rows.map((prompt) => [prompt.id, prompt]));
      const order = readPromptOrder(db);
      const prompts = orderedPromptIds(
        rows.map((prompt) => prompt.id),
        order.ids,
      ).map((id) => {
        const prompt = byId.get(id);
        if (!prompt) throw new PromptNotFoundError(id);
        return prompt;
      });
      return { prompts, orderVersion: order.version };
    })();

  const select = db.query<Prompt, [string]>(`SELECT ${columns} FROM core_prompts WHERE id = ?`);
  const get = (id: string): Prompt | undefined => select.get(id) ?? undefined;

  return {
    list: (): Prompt[] => catalog().prompts,
    catalog,
    reorder(input: { ids: string[]; expectedOrderVersion: number }): PromptCatalog {
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 256 ||
        !input.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128) ||
        new Set(input.ids).size !== input.ids.length ||
        !Number.isSafeInteger(input.expectedOrderVersion) ||
        input.expectedOrderVersion < 1
      ) {
        throw new PromptOrderValidationError(
          "Provide each section exactly once and the current order version.",
        );
      }
      return db
        .transaction(() => {
          const current = catalog();
          const ids = current.prompts.map((prompt) => prompt.id);
          if (
            input.expectedOrderVersion !== current.orderVersion ||
            input.ids.length !== ids.length ||
            input.ids.some((id) => !ids.includes(id))
          )
            throw new PromptOrderConflictError();
          if (ids.includes(POST_HISTORY_ID) && input.ids.at(-1) !== POST_HISTORY_ID)
            throw new PromptOrderValidationError(
              "Post-History Instructions must stay last, after the conversation history.",
            );
          if (input.ids.every((id, index) => id === ids[index])) return current;
          db.query(
            "UPDATE core_prompt_order SET ids_json = ?, version = version + 1, updated_at = ? WHERE singleton = 1",
          ).run(JSON.stringify(input.ids), new Date().toISOString());
          return catalog();
        })
        .immediate();
    },
    get,
    update(id: string, input: { content: string; expectedVersion: number }): Prompt {
      if (
        typeof input.content !== "string" ||
        Buffer.byteLength(input.content, "utf8") > MAX_PROMPT_BYTES
      ) {
        throw new TypeError("Prompt content must be a string of at most 256 KiB.");
      }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new TypeError("A positive expectedVersion is required to save a prompt.");
      }
      return db
        .transaction(() => {
          const current = get(id);
          if (!current) throw new PromptNotFoundError(id);
          if (current.version !== input.expectedVersion) {
            throw new PromptConflictError(id, input.expectedVersion, current.version);
          }
          const now = new Date().toISOString();
          const version = current.version + 1;
          db.query(
            "UPDATE core_prompts SET content = ?, version = ?, updated_at = ? WHERE id = ?",
          ).run(input.content, version, now, id);
          db.query(
            "INSERT INTO core_prompt_revisions (prompt_id, version, content, created_at) VALUES (?, ?, ?, ?)",
          ).run(id, version, input.content, now);
          return { ...current, content: input.content, version, updatedAt: now };
        })
        .immediate();
    },
    history(id: string): PromptRevision[] {
      if (!get(id)) throw new PromptNotFoundError(id);
      return db
        .query<PromptRevision, [string]>(`
        SELECT prompt_id AS promptId, version, content, created_at AS createdAt
        FROM core_prompt_revisions WHERE prompt_id = ? ORDER BY version DESC
      `)
        .all(id);
    },
    compose(
      channel: CommunicationChannel,
      options: {
        imageGeneration?: boolean;
        memoryTools?: boolean;
        heartbeat?: boolean;
        growthFocus?: boolean;
        dailyRecords?: boolean;
        agreements?: boolean;
        reminderDelivery?: boolean;
        habitCheckin?: boolean;
      } = {},
    ): PromptSnapshot {
      if (!communicationChannels.includes(channel))
        throw new TypeError("Unknown communication channel.");
      return db.transaction((): PromptSnapshot => {
        const active = db
          .query<{ importId: string }, []>(
            "SELECT import_id AS importId FROM core_character_active WHERE singleton = 1",
          )
          .get();
        const sourceIds = active
          ? [
              "character.system-prompt",
              "character.description",
              "character.personality",
              "character.scenario",
              ...(channel === "telegram-text" ? ["character.examples"] : []),
            ]
          : [];
        const ids = [
          "identity",
          ...sourceIds,
          "personality",
          "conversation-context",
          ...(channel === "telegram-text" && options.memoryTools ? ["memory-direction"] : []),
          "relationship",
          "voice",
          channel === "telegram-text" ? "channel.telegram-text" : "channel.telegram-voice",
          ...(channel === "telegram-text" && options.imageGeneration ? ["image-generation"] : []),
          ...(channel === "telegram-text" && options.heartbeat ? ["heartbeat"] : []),
          ...(options.growthFocus ? ["growth-focus"] : []),
          ...(channel === "telegram-text" && options.dailyRecords ? ["daily-records"] : []),
          ...(options.agreements ? ["rules"] : []),
          ...(channel === "telegram-text" && options.reminderDelivery ? ["reminders"] : []),
          ...(channel === "telegram-text" && options.habitCheckin ? ["habits"] : []),
          ...(active ? ["character.post-history"] : []),
        ];
        const current = catalog();
        for (const id of ids) {
          if (!current.prompts.some((prompt) => prompt.id === id))
            throw new PromptNotFoundError(id);
        }
        const prompts = current.prompts.filter((prompt) => ids.includes(prompt.id));
        const section = (prompt: Prompt) =>
          prompt.content.length > 0 ? `# ${prompt.title}\n\n${prompt.content}` : "";
        return {
          channel,
          orderVersion: current.orderVersion,
          content: prompts
            .filter((prompt) => prompt.id !== POST_HISTORY_ID)
            .map(section)
            .filter((content) => content.length > 0)
            .join("\n\n"),
          postHistoryContent: prompts
            .filter((prompt) => prompt.id === POST_HISTORY_ID)
            .map(section)
            .join(""),
          postHistoryPlacement: "after-history",
          characterImportId: active?.importId ?? null,
          prompts,
          versions: Object.fromEntries(prompts.map((prompt) => [prompt.id, prompt.version])),
          placements: Object.fromEntries(
            prompts.map((prompt) => [
              prompt.id,
              prompt.id === "character.post-history"
                ? "after-history"
                : prompt.id === "character.examples"
                  ? "telegram-text-example"
                  : "system",
            ]),
          ),
        };
      })();
    },
  };
}

export type PromptService = ReturnType<typeof createPromptService>;
