import type { Store } from "../../store";

export type ActivityStatus = "succeeded" | "failed" | "pending";

export interface Activity {
  id: string;
  kind: string;
  summary: string;
  status: ActivityStatus;
  createdAt: string;
  metadataJson: string;
}

export interface ActivityQuery {
  /** Case-insensitive substring match against kind and summary; never metadata. */
  query?: string;
  /** Defaults to seven days ago. Use outstanding() for pending work of any age. */
  since?: string | Date;
  limit?: number;
  status?: ActivityStatus;
}

const columns = "id, kind, summary, status, created_at AS createdAt, metadata_json AS metadataJson";
const statuses: ActivityStatus[] = ["succeeded", "failed", "pending"];

function validateStatus(status: ActivityStatus): void {
  if (!statuses.includes(status)) throw new TypeError("Unknown activity status.");
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError("Activity limit must be an integer between 1 and 1000.");
  }
}

export function createActivityService({ db }: Store) {
  const select = db.query<Activity, [string]>(`SELECT ${columns} FROM core_activity WHERE id = ?`);
  const get = (id: string): Activity | undefined => select.get(id) ?? undefined;

  return {
    get,
    append(input: {
      kind: string;
      summary: string;
      status?: ActivityStatus;
      metadata?: unknown;
    }): Activity {
      if (typeof input.kind !== "string" || !input.kind.trim() || input.kind.length > 100) {
        throw new TypeError("Activity kind must contain between 1 and 100 characters.");
      }
      if (
        typeof input.summary !== "string" ||
        !input.summary.trim() ||
        input.summary.length > 8192
      ) {
        throw new TypeError("Activity summary must contain between 1 and 8192 characters.");
      }
      const status = input.status ?? "succeeded";
      validateStatus(status);
      const metadataJson = JSON.stringify(input.metadata ?? {});
      if (metadataJson === undefined || Buffer.byteLength(metadataJson, "utf8") > 64 * 1024) {
        throw new TypeError("Activity metadata must be JSON serializable and at most 64 KiB.");
      }
      const activity = {
        id: crypto.randomUUID(),
        kind: input.kind,
        summary: input.summary,
        status,
        createdAt: new Date().toISOString(),
        metadataJson,
      };
      db.query(
        "INSERT INTO core_activity (id, kind, summary, status, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        activity.id,
        activity.kind,
        activity.summary,
        activity.status,
        activity.createdAt,
        activity.metadataJson,
      );
      return activity;
    },
    list(options: ActivityQuery = {}): Activity[] {
      const limit = options.limit ?? 100;
      validateLimit(limit);
      if (options.status !== undefined) validateStatus(options.status);
      if (
        options.query !== undefined &&
        (typeof options.query !== "string" || options.query.length > 1000)
      ) {
        throw new TypeError("Activity search text must be a string of at most 1000 characters.");
      }
      const sinceValue = options.since instanceof Date ? options.since.valueOf() : options.since;
      const since = new Date(sinceValue ?? Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (!Number.isFinite(since.valueOf()))
        throw new TypeError("Activity since must be a valid date.");
      // instr uses literal text: '%' and '_' are not SQL search wildcards.
      return db
        .query<Activity, [string, string | null, string | null, string, string, number]>(`
        SELECT ${columns} FROM core_activity
        WHERE created_at >= ? AND (? IS NULL OR status = ?)
          AND (instr(lower(kind), lower(?)) > 0 OR instr(lower(summary), lower(?)) > 0)
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      `)
        .all(
          since.toISOString(),
          options.status ?? null,
          options.status ?? null,
          options.query ?? "",
          options.query ?? "",
          limit,
        );
    },
    /** All pending records, including work older than the recent-activity window. */
    outstanding(): Activity[] {
      return db
        .query<Activity, []>(`
        SELECT ${columns} FROM core_activity WHERE status = 'pending' ORDER BY created_at, rowid
      `)
        .all();
    },
    /** Resolve or reopen tracked work. Append a separate activity for its outcome details. */
    updateStatus(id: string, status: ActivityStatus): Activity {
      validateStatus(status);
      return db
        .transaction(() => {
          const activity = get(id);
          if (!activity) throw new Error(`Activity '${id}' does not exist.`);
          db.query("UPDATE core_activity SET status = ? WHERE id = ?").run(status, id);
          return { ...activity, status };
        })
        .immediate();
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
