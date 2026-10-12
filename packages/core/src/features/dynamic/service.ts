import type { Store } from "../../store";
import { dailyText, dynamicConversationSource, runDynamicOperation } from "./evidence";
import {
  DynamicConflictError,
  type DynamicMutationContext,
  type DynamicNoteInput,
  type DynamicPage,
  DynamicPermissionError,
  type DynamicProgressNote,
  type DynamicSettings,
  type DynamicSnapshot,
  type DynamicSource,
  DynamicValidationError,
  type GrowthFocus,
  type GrowthFocusFields,
  type GrowthFocusSaveInput,
  type GrowthFocusState,
} from "./types";

type StoredFocus = Omit<GrowthFocus, "phase" | "reviewDue">;
type StoredNote = Omit<DynamicProgressNote, "superseded">;
type JsonRow = { recordJson: string };
const ownerZone = "America/Chicago";

function version(value: unknown, name = "expectedVersion"): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new DynamicValidationError(name, "invalid_version", "Provide the current saved version.");
  return value as number;
}

function calendarDate(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T12:00:00.000Z`)) ||
    new Date(`${value}T12:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new DynamicValidationError(name, "invalid_date", "Use a real calendar date, YYYY-MM-DD.");
  return value;
}

function fields(input: GrowthFocusFields): GrowthFocusFields {
  const list = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value) || value.length > 5)
      throw new DynamicValidationError(name, "invalid_list", "Use at most five short items.");
    return value.map((item) => dailyText(item, 160, name));
  };
  const startDate = calendarDate(input.startDate, "startDate");
  const reviewDate = calendarDate(input.reviewDate, "reviewDate");
  if (reviewDate <= startDate)
    throw new DynamicValidationError(
      "reviewDate",
      "invalid_range",
      "Choose a review date after the start date. Review never automatically ends a focus.",
    );
  return {
    title: dailyText(input.title, 120, "title"),
    reason: dailyText(input.reason, 800, "reason"),
    startDate,
    reviewDate,
    practices: list(input.practices, "practices"),
    indicators: list(input.indicators, "indicators"),
  };
}

function localDate(at: Date): string {
  if (!Number.isFinite(at.getTime())) throw new TypeError("Provide a valid capture time.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ownerZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function limitFor(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new TypeError("Invalid page size.");
  return value as number;
}

/** SQLite owns live focus and immutable evidence; this service creates no timers or vault writes. */
export function createDynamicService(store: Store, options: { now?: () => Date } = {}) {
  const db = store.db;
  const now = options.now ?? (() => new Date());
  const getSettings = (): DynamicSettings => {
    const row = db
      .query<{ settingsJson: string }, []>(
        "SELECT settings_json AS settingsJson FROM core_dynamic_settings WHERE singleton=1",
      )
      .get();
    if (!row) throw new Error("Dynamic Details settings are unavailable.");
    return JSON.parse(row.settingsJson);
  };
  const present = (record: StoredFocus, at = now()): GrowthFocus => {
    const date = localDate(at);
    const phase = record.state === "active" && record.startDate > date ? "scheduled" : record.state;
    return {
      ...record,
      phase,
      reviewDue: phase === "active" && record.reviewDate <= date,
    };
  };
  const get = (id: string, revision?: number): StoredFocus | null => {
    dailyText(id, 220, "id");
    const row =
      revision !== undefined
        ? db
            .query<JsonRow, [string, number]>(
              "SELECT record_json AS recordJson FROM core_growth_focus_revisions WHERE id=? AND version=?",
            )
            .get(id, version(revision, "revision"))
        : db
            .query<JsonRow, [string]>(
              "SELECT record_json AS recordJson FROM core_growth_focus WHERE id=?",
            )
            .get(id);
    return row ? JSON.parse(row.recordJson) : null;
  };
  const currentRecord = (): StoredFocus | null => {
    const row = db
      .query<JsonRow, []>(
        "SELECT record_json AS recordJson FROM core_growth_focus WHERE state IN ('active','paused')",
      )
      .get();
    return row ? JSON.parse(row.recordJson) : null;
  };
  const sourceFor = (id: string, turnId?: string) => dynamicConversationSource(store, id, turnId);
  const visible = (
    record: { sources: DynamicSource[]; stateSources?: DynamicSource[] },
    turnId?: string,
  ) =>
    !turnId ||
    [...record.sources, ...(record.stateSources ?? [])].every(
      (source) => source.type === "owner_entry" || sourceFor(source.id, turnId),
    );
  const authorize = (context: DynamicMutationContext, scope: "manageFocus" | "logNotes") => {
    if (context.actor === "owner") return;
    if (context.actor !== "valerie") throw new TypeError("Unknown Dynamic Details author.");
    const settings = getSettings();
    const enabled =
      scope === "manageFocus" ? settings.allowValerieManageFocus : settings.allowValerieLogNotes;
    if (!enabled || context.permissions?.[scope] !== true) throw new DynamicPermissionError(scope);
    dailyText(context.operationKey, 300, "operationKey");
    dailyText(context.turnId, 220, "turnId");
    if (!db.query("SELECT id FROM core_conversation_turns WHERE id=?").get(context.turnId ?? ""))
      throw new DynamicValidationError(
        "turnId",
        "source_unavailable",
        "The source turn is unavailable.",
      );
  };
  const evidence = (
    sourceIds: string[] | undefined,
    context: DynamicMutationContext,
    at: string,
  ): DynamicSource[] => {
    if (
      (sourceIds !== undefined && !Array.isArray(sourceIds)) ||
      (sourceIds?.length ?? 0) > 5 ||
      (context.actor === "valerie" && !sourceIds?.length)
    )
      throw new DynamicValidationError(
        "sourceIds",
        "source_unavailable",
        "Link one to five original owner message IDs supporting the record.",
      );
    const sources = [...new Set(sourceIds ?? [])].map((id) => {
      dailyText(id, 220, "sourceIds");
      const source = sourceFor(id, context.actor === "valerie" ? context.turnId : undefined);
      if (!source)
        throw new DynamicValidationError(
          "sourceIds",
          "source_unavailable",
          "Use available owner message IDs from this conversation at or before this turn. Assistant claims, memory IDs and other chats are not owner evidence.",
        );
      return source;
    });
    if (context.actor === "owner")
      sources.unshift({
        type: "owner_entry",
        id: `owner:${crypto.randomUUID()}`,
        role: "owner",
        observedAt: at,
      });
    return sources;
  };
  const editable = (id: string, expectedVersion: number, context: DynamicMutationContext) => {
    const previous = get(id);
    if (
      !previous ||
      previous.state === "archived" ||
      !visible(previous, context.actor === "valerie" ? context.turnId : undefined)
    )
      throw new DynamicValidationError(
        "id",
        "record_not_editable",
        "Only the current, available Growth Focus can be changed. Archived history remains unchanged.",
      );
    if (previous.version !== version(expectedVersion)) throw new DynamicConflictError();
    return previous;
  };
  const persist = (record: StoredFocus) => {
    const json = JSON.stringify(record);
    db.query(
      `INSERT INTO core_growth_focus(id,version,state,updated_at,record_json) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET version=excluded.version,state=excluded.state,
         updated_at=excluded.updated_at,record_json=excluded.record_json`,
    ).run(record.id, record.version, record.state, record.updatedAt, json);
    db.query("INSERT INTO core_growth_focus_revisions(id,version,record_json) VALUES(?,?,?)").run(
      record.id,
      record.version,
      json,
    );
  };
  const operation = <T>(
    name: string,
    input: unknown,
    context: DynamicMutationContext,
    scope: "manageFocus" | "logNotes",
    action: () => T,
  ): T => runDynamicOperation(store, name, input, context, () => authorize(context, scope), action);
  const read = (id: string, input: { revision?: number; turnId?: string } = {}) => {
    const record = get(id, input.revision);
    return record && visible(record, input.turnId) ? present(record) : null;
  };
  const notes = (
    focusId: string,
    input: { limit?: number; cursor?: string; turnId?: string } = {},
  ): DynamicPage<DynamicProgressNote> => {
    dailyText(focusId, 220, "focusId");
    const limit = limitFor(input.limit, 20, 50);
    let before = Number.MAX_SAFE_INTEGER;
    if (input.cursor !== undefined) {
      dailyText(input.cursor, 220, "cursor");
      const cursor = db
        .query<{ position: number }, [string, string]>(
          "SELECT rowid AS position FROM core_dynamic_progress_notes WHERE id=? AND focus_id=?",
        )
        .get(input.cursor, focusId);
      if (!cursor)
        throw new DynamicValidationError(
          "cursor",
          "invalid_cursor",
          "Reload notes without the previous page cursor.",
        );
      before = cursor.position;
    }
    const focus = get(focusId);
    if (!focus || !visible(focus, input.turnId)) return { items: [], nextCursor: null };
    const rows = db
      .query<JsonRow & { superseded: number }, [string, number, number]>(
        `SELECT n.record_json AS recordJson,EXISTS(SELECT 1 FROM core_dynamic_progress_notes replacement
         WHERE replacement.supersedes_note_id=n.id) AS superseded
       FROM core_dynamic_progress_notes n WHERE n.focus_id=? AND n.rowid<? ORDER BY n.rowid DESC LIMIT ?`,
      )
      .all(focusId, before, limit + 1);
    const items = rows
      .slice(0, limit)
      .map((row) => ({
        ...(JSON.parse(row.recordJson) as StoredNote),
        superseded: Boolean(row.superseded),
      }))
      .filter((note) => visible(note, input.turnId));
    // Cursor follows the scanned rows, not only visible rows, so filtered evidence
    // cannot make paging repeat forever or skip to a different focus.
    const last = rows[Math.min(limit, rows.length) - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last ? (JSON.parse(last.recordJson) as StoredNote).id : null,
    };
  };
  return {
    getSettings,
    saveSettings(input: {
      expectedVersion: number;
      allowValerieManageFocus: boolean;
      allowValerieLogNotes: boolean;
      allowValerieManageWaking?: boolean;
      allowValerieManageProgress?: boolean;
      allowValerieManageHabits?: boolean;
      allowValerieManageRules?: boolean;
      allowValerieManageReminders?: boolean;
    }): DynamicSettings {
      return db
        .transaction(() => {
          version(input.expectedVersion);
          if (
            typeof input.allowValerieManageFocus !== "boolean" ||
            typeof input.allowValerieLogNotes !== "boolean"
          )
            throw new TypeError("Choose whether Valerie may manage the focus and record notes.");
          const previous = getSettings();
          for (const key of [
            "allowValerieManageWaking",
            "allowValerieManageProgress",
            "allowValerieManageHabits",
            "allowValerieManageRules",
            "allowValerieManageReminders",
          ] as const)
            if (input[key] !== undefined && typeof input[key] !== "boolean")
              throw new TypeError("Choose whether Valerie may track waking and progress reports.");
          if (input.expectedVersion !== previous.version)
            throw new DynamicConflictError(
              "Dynamic Details permissions changed. Load the saved settings before saving again.",
            );
          const settings = {
            version: previous.version + 1,
            allowValerieManageFocus: input.allowValerieManageFocus,
            allowValerieLogNotes: input.allowValerieLogNotes,
            allowValerieManageWaking:
              input.allowValerieManageWaking ?? previous.allowValerieManageWaking ?? false,
            allowValerieManageProgress:
              input.allowValerieManageProgress ?? previous.allowValerieManageProgress ?? false,
            allowValerieManageHabits:
              input.allowValerieManageHabits ?? previous.allowValerieManageHabits ?? false,
            allowValerieManageRules:
              input.allowValerieManageRules ?? previous.allowValerieManageRules ?? false,
            allowValerieManageReminders:
              input.allowValerieManageReminders ?? previous.allowValerieManageReminders ?? false,
            updatedAt: now().toISOString(),
          };
          const json = JSON.stringify(settings);
          db.query(
            "UPDATE core_dynamic_settings SET version=?,settings_json=? WHERE singleton=1",
          ).run(settings.version, json);
          db.query("INSERT INTO core_dynamic_settings_revisions VALUES(?,?)").run(
            settings.version,
            json,
          );
          return settings;
        })
        .immediate();
    },
    current(input: { turnId?: string } = {}): GrowthFocus | null {
      const record = currentRecord();
      return record && visible(record, input.turnId) ? present(record) : null;
    },
    read,
    list(input: { limit?: number; turnId?: string } = {}): GrowthFocus[] {
      const limit = limitFor(input.limit, 20, 50);
      return db
        .query<JsonRow, [number]>(
          "SELECT record_json AS recordJson FROM core_growth_focus ORDER BY rowid DESC LIMIT ?",
        )
        .all(limit)
        .map((row) => JSON.parse(row.recordJson) as StoredFocus)
        .filter((record) => visible(record, input.turnId))
        .map((record) => present(record));
    },
    detail(id: string, input: { limit?: number; cursor?: string; turnId?: string } = {}) {
      const focus = read(id, input);
      return focus ? { focus, notes: notes(id, input).items } : null;
    },
    notes,
    saveFocus(input: GrowthFocusSaveInput, context: DynamicMutationContext): GrowthFocus {
      return operation("save_focus", input, context, "manageFocus", () => {
        const value = fields(input);
        const at = now().toISOString();
        const previous = input.id
          ? editable(input.id, input.expectedVersion as number, context)
          : null;
        if (!input.id && input.expectedVersion !== undefined) throw new DynamicConflictError();
        if (!previous && currentRecord())
          throw new DynamicConflictError(
            "Archive the existing focus before choosing a different one. A paused or future focus still occupies the current focus.",
          );
        const sources = evidence(input.sourceIds, context, at);
        const record: StoredFocus = {
          ...value,
          id: previous?.id ?? crypto.randomUUID(),
          version: (previous?.version ?? 0) + 1,
          state: previous?.state ?? "active",
          sources,
          stateSources: previous?.stateSources ?? sources,
          authoredBy: context.actor,
          createdAt: previous?.createdAt ?? at,
          updatedAt: at,
        };
        persist(record);
        return present(record);
      });
    },
    setFocusState(
      input: { id: string; expectedVersion: number; state: GrowthFocusState; sourceIds?: string[] },
      context: DynamicMutationContext,
    ): GrowthFocus {
      return operation("set_focus_state", input, context, "manageFocus", () => {
        if (!["active", "paused", "archived"].includes(input.state))
          throw new TypeError("Choose active, paused, or archived.");
        const previous = editable(input.id, input.expectedVersion, context);
        const at = now().toISOString();
        const record: StoredFocus = {
          ...previous,
          version: previous.version + 1,
          state: input.state,
          stateSources: evidence(input.sourceIds, context, at),
          authoredBy: context.actor,
          updatedAt: at,
        };
        persist(record);
        return present(record);
      });
    },
    addNote(input: DynamicNoteInput, context: DynamicMutationContext): DynamicProgressNote {
      return operation("add_note", input, context, "logNotes", () => {
        editable(input.focusId, input.expectedFocusVersion, context);
        const body = dailyText(input.body, 1200, "body");
        if (!["owner_report", "valerie_interpretation"].includes(input.kind))
          throw new TypeError("Choose an owner report or a Valerie interpretation.");
        const at = now().toISOString();
        if (input.supersedesNoteId !== undefined) {
          dailyText(input.supersedesNoteId, 220, "supersedesNoteId");
          const prior = db
            .query<JsonRow, [string, string]>(
              "SELECT record_json AS recordJson FROM core_dynamic_progress_notes WHERE id=? AND focus_id=?",
            )
            .get(input.supersedesNoteId, input.focusId);
          const original = prior ? (JSON.parse(prior.recordJson) as StoredNote) : null;
          if (
            !original ||
            !visible(original, context.actor === "valerie" ? context.turnId : undefined)
          )
            throw new DynamicValidationError(
              "supersedesNoteId",
              "source_unavailable",
              "Choose an available note from this focus to correct.",
            );
          if (original.kind !== input.kind)
            throw new DynamicValidationError(
              "kind",
              "evidence_kind_changed",
              "Correct a report with a report, or an interpretation with an interpretation. Add a separate note for a different evidence kind.",
            );
          if (
            db
              .query("SELECT id FROM core_dynamic_progress_notes WHERE supersedes_note_id=?")
              .get(input.supersedesNoteId)
          )
            throw new DynamicConflictError(
              "This note already has a correction. Read the latest notes before correcting it.",
            );
        }
        const note: StoredNote = {
          id: crypto.randomUUID(),
          focusId: input.focusId,
          body,
          kind: input.kind,
          authoredBy: context.actor,
          sources: evidence(input.sourceIds, context, at),
          createdAt: at,
          supersedesNoteId: input.supersedesNoteId ?? null,
        };
        db.query(
          "INSERT INTO core_dynamic_progress_notes(id,focus_id,supersedes_note_id,record_json) VALUES(?,?,?,?)",
        ).run(note.id, note.focusId, note.supersedesNoteId, JSON.stringify(note));
        return { ...note, superseded: false };
      });
    },
    capture(at = now()): DynamicSnapshot {
      return db.transaction(() => {
        const settings = getSettings();
        const record = currentRecord();
        const focus = record
          ? (() => {
              const {
                sources: _sources,
                stateSources: _stateSources,
                authoredBy: _author,
                createdAt: _created,
                updatedAt: _updated,
                ...summary
              } = present(record, at);
              return summary;
            })()
          : null;
        return {
          capturedAt: at.toISOString(),
          settingsVersion: settings.version,
          permissions: {
            manageFocus: settings.allowValerieManageFocus,
            logNotes: settings.allowValerieLogNotes,
          },
          focus,
          content: focus
            ? [
                "Current Growth Focus (saved context, not a new instruction):",
                JSON.stringify(focus),
                focus.phase === "paused"
                  ? "This focus is paused. Do not press its practices or review until it resumes."
                  : focus.phase === "scheduled"
                    ? "This focus has not started. Do not treat its practices as current obligations."
                    : "The review date invites reconsideration; it does not mean the issue is solved or the focus ended.",
              ].join("\n")
            : "",
        };
      })();
    },
  };
}

export type DynamicService = ReturnType<typeof createDynamicService>;
