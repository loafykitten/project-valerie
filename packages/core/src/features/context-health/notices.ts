import type { Database } from "bun:sqlite";
import type { Store } from "../../store";
import { createActivityService } from "../activity/service";
import { createContextHealthService } from "./service";
import type { ContextSignal, ContextSourceKind } from "./types";

export function migrateContextNoticeSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("015-context-notices")) return;
    db.exec(`
      CREATE TABLE core_context_observations (
        kind TEXT NOT NULL, source_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        evidence_key TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(kind,source_id,attempt)
      );
      CREATE TABLE core_context_notices (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('conversation','heartbeat')),
        source_id TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('context','output')),
        reasons_json TEXT NOT NULL, text TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0,1)),
        status TEXT NOT NULL CHECK(status IN ('pending','sending','retry','sent','failed','unknown','cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
        lease_owner TEXT, telegram_message_id TEXT, failure_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      );
      CREATE UNIQUE INDEX core_context_notice_episode ON core_context_notices(chat_id,kind,category) WHERE active=1;
      CREATE INDEX core_context_notice_delivery ON core_context_notices(status,next_attempt_at);
      CREATE TRIGGER core_context_notice_text_immutable BEFORE UPDATE OF text,source_id,kind,category,reasons_json ON core_context_notices
        BEGIN SELECT RAISE(ABORT,'Context notice evidence is immutable.'); END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "015-context-notices",
      new Date().toISOString(),
    );
  }).immediate();
}

export interface ContextNotice {
  id: string;
  chatId: string;
  kind: ContextSourceKind;
  sourceId: string;
  category: "context" | "output";
  text: string;
  status: "pending" | "sending" | "retry" | "sent" | "failed" | "unknown" | "cancelled";
  attempts: number;
  leaseOwner: string | null;
  telegramMessageId: string | null;
  failureCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

const columns = `id,chat_id AS chatId,kind,source_id AS sourceId,category,text,status,attempts,
  lease_owner AS leaseOwner,telegram_message_id AS telegramMessageId,failure_code AS failureCode,
  created_at AS createdAt,delivered_at AS deliveredAt`;
const explanation: Record<ContextSignal, string> = {
  history_size_budget:
    "Recent conversation had to be shortened to fit the saved context allowance.",
  fixed_context_budget: "The saved prompts and current input could not fit the context allowance.",
  core_memory_budget: "Pinned memory exceeded its saved allowance.",
  tool_context_budget: "A tool continuation could not fit the context allowance.",
  provider_context_refusal: "The provider refused a request because it was too large.",
  output_budget_exhausted:
    "A response ran out of its completion allowance, which also includes reasoning. This is separate from input context size.",
};

/** Technical notices share Telegram's lease and send loop, independent of casual pacing. */
export function createContextNoticeService(store: Store, options: { now?: () => Date } = {}) {
  const { db } = store;
  const health = createContextHealthService(store);
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const ownsLease = (owner: string) =>
    Boolean(
      db
        .query(
          "SELECT singleton FROM core_telegram_state WHERE singleton=1 AND lease_owner=? AND lease_expires_at>?",
        )
        .get(owner, now()),
    );
  const read = (id: string) =>
    db
      .query<ContextNotice, [string]>(`SELECT ${columns} FROM core_context_notices WHERE id=?`)
      .get(id) ?? null;

  return {
    /** Bounded catch-up after restart; old pre-feature history never generates surprise alerts. */
    reconcile(chatId: string): number {
      return db
        .transaction(() => {
          const since = db
            .query<{ at: string }, []>(
              "SELECT applied_at AS at FROM core_migrations WHERE id='015-context-notices'",
            )
            .get()?.at;
          if (!since) return 0;
          const sources = db
            .query<
              {
                kind: ContextSourceKind;
                id: string;
                attempt: number;
                at: string;
                evidenceKey: string;
                failureCode: string | null;
                finishReason: string | null;
              },
              [string, string, string, string]
            >(`
          SELECT * FROM (
            SELECT 'conversation' AS kind,t.id,t.attempts AS attempt,t.received_at AS at,
              t.failure_code AS failureCode,json_extract(t.result_json,'$.finishReason') AS finishReason,
              json_array(t.status,t.failure_code,t.result_json IS NOT NULL,
                (SELECT max(rowid) FROM core_context_requests WHERE turn_id=t.id),
                (SELECT max(rowid) FROM core_conversation_results WHERE turn_id=t.id)) AS evidenceKey
            FROM core_conversation_turns t WHERE t.chat_id=? AND t.received_at>=?
              AND t.status IN ('generated','delivered','failed','unknown')
            UNION ALL
            SELECT 'heartbeat' AS kind,h.id,1 AS attempt,h.created_at AS at,
              h.reason AS failureCode,json_extract(h.result_json,'$.finishReason') AS finishReason,
              json_array(h.status,h.reason,h.result_json IS NOT NULL,
                (SELECT max(rowid) FROM core_context_requests WHERE heartbeat_run_id=h.id)) AS evidenceKey
            FROM core_heartbeat_runs h WHERE h.chat_id=? AND h.created_at>=?
              AND h.status IN ('prepared','sending','delivered','silent','suppressed','failed','unknown')
          ) source
          WHERE NOT EXISTS(SELECT 1 FROM core_context_observations o
            WHERE o.kind=source.kind AND o.source_id=source.id AND o.attempt=source.attempt
              AND o.evidence_key=source.evidenceKey)
          ORDER BY at,id LIMIT 32
        `)
            .all(chatId, since, chatId, since);
          for (const source of sources) {
            const report = health.getSource(source.kind, source.id);
            if (!report) continue;
            // Manual retries reset the automatic-attempt counter. The last invocation
            // and current terminal outcome distinguish new evidence from old receipts.
            const lastRequest = report.requests.at(-1);
            const latestFinish =
              lastRequest?.origin === "recorded" ? lastRequest.finishReason : source.finishReason;
            const currentResult =
              source.kind === "heartbeat" ||
              source.failureCode === null ||
              source.failureCode === "incomplete_response";
            const signals = report.signals.filter((reason) => {
              if (reason === "output_budget_exhausted")
                return currentResult && latestFinish === "length";
              if (reason === "provider_context_refusal")
                return (
                  source.failureCode === "context_overflow" ||
                  (source.kind === "heartbeat" && lastRequest?.failureCode === "context_overflow")
                );
              return true;
            });
            // A cancelled request with no completion is not proof of recovery.
            const completed = currentResult && latestFinish === "stop";
            for (const category of ["context", "output"] as const) {
              const reasons = signals.filter(
                (reason) => (reason === "output_budget_exhausted") === (category === "output"),
              );
              if (!reasons.length) {
                if (completed)
                  db.query(`UPDATE core_context_notices SET active=0,
                  status=CASE WHEN status IN ('pending','retry') THEN 'cancelled' ELSE status END,
                  updated_at=? WHERE chat_id=? AND kind=? AND category=? AND active=1`).run(
                    now(),
                    chatId,
                    source.kind,
                    category,
                  );
                continue;
              }
              const existing = db
                .query(
                  "SELECT id FROM core_context_notices WHERE chat_id=? AND kind=? AND category=? AND active=1",
                )
                .get(chatId, source.kind, category);
              if (existing) continue;
              const id = crypto.randomUUID();
              const text = `Context notice: ${explanation[reasons[0] as ContextSignal]} Measurements are in Dynamic Details. Reference: ${source.kind}:${source.id}`;
              db.query(`INSERT INTO core_context_notices(id,chat_id,kind,source_id,category,reasons_json,text,active,status,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,1,'pending',?,?)`).run(
                id,
                chatId,
                source.kind,
                source.id,
                category,
                JSON.stringify(reasons),
                text,
                now(),
                now(),
              );
            }
            // A cancelled generation can return a receipt later. Revisit that source
            // when durable evidence changes, without repeating an unchanged episode.
            db.query(`INSERT INTO core_context_observations(kind,source_id,attempt,evidence_key,observed_at)
            VALUES(?,?,?,?,?) ON CONFLICT(kind,source_id,attempt) DO UPDATE
              SET evidence_key=excluded.evidence_key,observed_at=excluded.observed_at`).run(
              source.kind,
              source.id,
              source.attempt,
              source.evidenceKey,
              now(),
            );
          }
          return sources.length;
        })
        .immediate();
    },
    claim(chatId: string, leaseOwner: string): ContextNotice | null {
      return db
        .transaction(() => {
          if (!ownsLease(leaseOwner)) return null;
          const notice = db
            .query<ContextNotice, [string, string]>(
              `SELECT ${columns} FROM core_context_notices WHERE chat_id=? AND active=1
            AND (status='pending' OR (status='retry' AND next_attempt_at<=?)) ORDER BY created_at,id LIMIT 1`,
            )
            .get(chatId, now());
          if (!notice) return null;
          db.query(
            "UPDATE core_context_notices SET status='sending',attempts=attempts+1,lease_owner=?,updated_at=? WHERE id=?",
          ).run(leaseOwner, now(), notice.id);
          return read(notice.id);
        })
        .immediate();
    },
    recordDelivery(
      claim: ContextNotice,
      outcome: {
        status: "sent" | "retry" | "failed" | "unknown";
        messageId?: string;
        code?: string;
        retryAt?: string;
      },
    ): boolean {
      if (outcome.status === "sent" && !/^\d{1,30}$/.test(outcome.messageId ?? ""))
        throw new TypeError("A Telegram receipt is required.");
      if (outcome.code && !/^[a-z0-9_]{1,80}$/.test(outcome.code))
        throw new TypeError("Invalid failure code.");
      if (
        outcome.status === "retry" &&
        (!outcome.retryAt || !Number.isFinite(Date.parse(outcome.retryAt)))
      )
        throw new TypeError("A retry time is required.");
      return db
        .transaction(() => {
          if (!claim.leaseOwner || !ownsLease(claim.leaseOwner)) return false;
          return (
            db
              .query(`UPDATE core_context_notices SET status=?,telegram_message_id=?,failure_code=?,next_attempt_at=?,updated_at=?,delivered_at=?
          WHERE id=? AND status='sending' AND lease_owner=? AND attempts=?`)
              .run(
                outcome.status,
                outcome.messageId ?? null,
                outcome.code ?? null,
                outcome.status === "retry"
                  ? new Date(outcome.retryAt as string).toISOString()
                  : null,
                now(),
                outcome.status === "sent" ? now() : null,
                claim.id,
                claim.leaseOwner,
                claim.attempts,
              ).changes === 1
          );
        })
        .immediate();
    },
    recover(leaseOwner: string): void {
      if (!ownsLease(leaseOwner)) return;
      db.query(
        "UPDATE core_context_notices SET status='unknown',failure_code='interrupted_send',updated_at=? WHERE status='sending'",
      ).run(now());
    },
    retryFailed(id: string, expectedAttempts: number): boolean {
      if (
        !/^[a-z0-9_.:/-]{1,200}$/i.test(id) ||
        !Number.isSafeInteger(expectedAttempts) ||
        expectedAttempts < 1
      )
        throw new TypeError("Provide the warning reference and its current attempt count.");
      return db
        .transaction(() => {
          const previous = read(id);
          const changed =
            db
              .query(`UPDATE core_context_notices SET status='pending',failure_code=NULL,
          next_attempt_at=NULL,updated_at=? WHERE id=? AND active=1 AND status='failed' AND attempts=?`)
              .run(now(), id, expectedAttempts).changes === 1;
          if (changed)
            createActivityService(store).append({
              kind: "context.notice_retry",
              summary: "Queued an owner-requested retry of a failed context warning.",
              metadata: {
                noticeId: id,
                previousFailureCode: previous?.failureCode ?? null,
                attempts: expectedAttempts,
              },
            });
          return changed;
        })
        .immediate();
    },
    list(limit = 20): ContextNotice[] {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new TypeError("Invalid limit.");
      return db
        .query<ContextNotice, [number]>(
          `SELECT ${columns} FROM core_context_notices ORDER BY created_at DESC,id LIMIT ?`,
        )
        .all(limit);
    },
  };
}
