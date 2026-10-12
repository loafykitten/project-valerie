import type { Store } from "../../store";
import { createActivityService } from "../activity/service";

export class MessageEditConflictError extends Error {}
export class MessageEditNotFoundError extends Error {}
export interface MessageEdit {
  id: string;
  deliveryId: string;
  expectedVersion: number;
  text: string;
  status: "queued" | "sending" | "applied" | "failed" | "unknown";
  attempts: number;
  leaseOwner: string | null;
  failureCode: string | null;
  retryAfter: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EditableMessage {
  id: string;
  turnId: string;
  sequence: number;
  text: string;
  version: number;
  chatId: string;
  telegramMessageId: string;
  deliveredAt: string;
}
const columns = `id,delivery_id AS deliveryId,expected_version AS expectedVersion,text,status,
  attempts,lease_owner AS leaseOwner,failure_code AS failureCode,retry_after AS retryAfter,
  created_at AS createdAt,updated_at AS updatedAt`;
const uuid = /^[a-f0-9]{8}-[a-f0-9-]{27}$/i;

/** Only owner dashboard requests can queue edits. This service never runs model tools. */
export function createMessageEditService(store: Store, now = () => new Date()) {
  const { db } = store;
  const activity = createActivityService(store);
  const get = (id: string) =>
    db.query<MessageEdit, [string]>(`SELECT ${columns} FROM core_message_edits WHERE id=?`).get(id);
  const requireEdit = (id: string): MessageEdit => {
    const edit = get(id);
    if (!edit) throw new MessageEditNotFoundError("Edit not found.");
    return edit;
  };
  const message = (id: string, ownerChatId: string): EditableMessage => {
    const row = db
      .query<EditableMessage, [string, string]>(`
      SELECT o.id,o.turn_id AS turnId,o.sequence,o.text,o.text_version AS version,
        t.chat_id AS chatId,o.telegram_message_id AS telegramMessageId,o.delivered_at AS deliveredAt
      FROM core_conversation_outbox o JOIN core_conversation_turns t ON t.id=o.turn_id
      WHERE o.id=? AND t.chat_id=? AND t.status='delivered'
        AND o.status='sent' AND o.telegram_message_id IS NOT NULL
    `)
      .get(id, ownerChatId);
    if (!row) throw new MessageEditNotFoundError("Delivered reply not found.");
    return row;
  };
  const assertLease = (owner: string) => {
    if (
      !db
        .query(
          "SELECT 1 FROM core_telegram_state WHERE singleton=1 AND lease_owner=? AND lease_expires_at>?",
        )
        .get(owner, now().toISOString())
    )
      throw new MessageEditConflictError("Telegram worker lease changed.");
  };
  const latest = (id: string) =>
    db
      .query<MessageEdit, [string]>(
        `SELECT ${columns} FROM core_message_edits WHERE delivery_id=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(id);
  return {
    messages(turnId: string, ownerChatId: string) {
      const ids = db
        .query<{ id: string }, [string, string]>(`
        SELECT o.id FROM core_conversation_outbox o JOIN core_conversation_turns t ON t.id=o.turn_id
        WHERE t.id=? AND t.chat_id=? AND t.status='delivered' AND o.status='sent'
        AND o.telegram_message_id IS NOT NULL ORDER BY o.sequence LIMIT 256
      `)
        .all(turnId, ownerChatId);
      if (!ids.length) throw new MessageEditNotFoundError("Delivered reply not found.");
      return ids.map(({ id }) => ({ ...message(id, ownerChatId), edit: latest(id) }));
    },
    history(id: string, ownerChatId: string, before = Number.MAX_SAFE_INTEGER) {
      const current = message(id, ownerChatId);
      if (!Number.isSafeInteger(before) || before < 1)
        throw new TypeError("Invalid revision cursor.");
      const rows = db
        .query<{ version: number; text: string; createdAt: string }, [string, number]>(`
        SELECT version,text,created_at AS createdAt FROM core_message_revisions
        WHERE delivery_id=? AND version<? ORDER BY version DESC LIMIT 50
      `)
        .all(id, before);
      return rows.length || current.version !== 1 || before <= 1
        ? rows
        : [{ version: 1, text: current.text, createdAt: current.deliveredAt }];
    },
    queue(
      input: { id: string; deliveryId: string; expectedVersion: number; text: string },
      ownerChatId: string,
    ) {
      if (
        !uuid.test(input.id) ||
        typeof input.text !== "string" ||
        !input.text.trim() ||
        input.text.length > 4096 ||
        /[\uD800-\uDFFF]/u.test(input.text) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1
      )
        throw new TypeError(
          "Provide a reply of 1–4,096 characters, its saved version, and an edit ID.",
        );
      return db
        .transaction(() => {
          const current = message(input.deliveryId, ownerChatId);
          const prior = get(input.id);
          if (prior) {
            if (
              prior.deliveryId !== input.deliveryId ||
              prior.expectedVersion !== input.expectedVersion ||
              prior.text !== input.text
            )
              throw new MessageEditConflictError(
                "This edit ID already belongs to another request.",
              );
            return prior;
          }
          if (current.version !== input.expectedVersion)
            throw new MessageEditConflictError(
              "This message changed. Reload it before saving your draft.",
            );
          const previous = latest(current.id);
          if (previous?.retryAfter && previous.retryAfter > now().toISOString())
            throw new MessageEditConflictError("Telegram requested a pause before another edit.");
          if (previous && ["queued", "sending", "unknown"].includes(previous.status))
            throw new MessageEditConflictError(
              "Resolve the existing edit before submitting another.",
            );
          if (current.text === input.text) throw new TypeError("The reply is unchanged.");
          const at = now().toISOString();
          db.query("INSERT OR IGNORE INTO core_message_revisions VALUES(?,?,?,?,NULL)").run(
            current.id,
            current.version,
            current.text,
            current.deliveredAt,
          );
          db.query(`INSERT INTO core_message_edits(id,delivery_id,expected_version,text,status,created_at,updated_at)
          VALUES(?,?,?,?,'queued',?,?)`).run(
            input.id,
            current.id,
            current.version,
            input.text,
            at,
            at,
          );
          activity.append({
            kind: "conversation.edit_queued",
            summary: "A reply edit is waiting for Telegram confirmation.",
            status: "succeeded",
            metadata: { editId: input.id },
          });
          return requireEdit(input.id);
        })
        .immediate();
    },
    retry(id: string, ownerChatId: string) {
      return db
        .transaction(() => {
          const edit = get(id);
          if (!edit) throw new MessageEditNotFoundError("Edit not found.");
          const current = message(edit.deliveryId, ownerChatId);
          if (
            latest(current.id)?.id !== id ||
            current.version !== edit.expectedVersion ||
            !["failed", "unknown"].includes(edit.status)
          )
            throw new MessageEditConflictError(
              "This edit can no longer be retried. Reload the message.",
            );
          if (edit.retryAfter && edit.retryAfter > now().toISOString())
            throw new MessageEditConflictError(
              "Telegram requested a pause before retrying this edit.",
            );
          db.query(
            "UPDATE core_message_edits SET status='queued',failure_code=NULL,updated_at=? WHERE id=?",
          ).run(now().toISOString(), id);
          return requireEdit(id);
        })
        .immediate();
    },
    claim(ownerChatId: string, leaseOwner: string) {
      return db
        .transaction(() => {
          assertLease(leaseOwner);
          const edit = db
            .query<MessageEdit, [string]>(`SELECT ${columns} FROM core_message_edits
          WHERE status='queued' AND delivery_id IN (SELECT o.id FROM core_conversation_outbox o
          JOIN core_conversation_turns t ON t.id=o.turn_id WHERE t.chat_id=?) ORDER BY rowid LIMIT 1`)
            .get(ownerChatId);
          if (!edit) return null;
          let current: EditableMessage;
          try {
            current = message(edit.deliveryId, ownerChatId);
            if (current.version !== edit.expectedVersion)
              throw new MessageEditConflictError("Stale queued edit.");
          } catch (error) {
            if (
              !(
                error instanceof MessageEditNotFoundError ||
                error instanceof MessageEditConflictError
              )
            )
              throw error;
            // A changed/corrupt target must not poison the entire shared worker.
            db.query(
              "UPDATE core_message_edits SET status='failed',failure_code='edit_target_changed',updated_at=? WHERE id=?",
            ).run(now().toISOString(), edit.id);
            activity.append({
              kind: "conversation.edit_result",
              summary: "A queued reply edit was rejected because its target changed.",
              status: "failed",
              metadata: { editId: edit.id },
            });
            return null;
          }
          db.query(
            "UPDATE core_message_edits SET status='sending',attempts=attempts+1,lease_owner=?,updated_at=? WHERE id=?",
          ).run(leaseOwner, now().toISOString(), edit.id);
          db.query(
            "INSERT INTO core_message_edit_attempts(edit_id,attempt,lease_owner,started_at) VALUES(?,?,?,?)",
          ).run(edit.id, edit.attempts + 1, leaseOwner, now().toISOString());
          return {
            ...requireEdit(edit.id),
            chatId: current.chatId,
            telegramMessageId: current.telegramMessageId,
          };
        })
        .immediate();
    },
    finish(
      claim: MessageEdit & { chatId: string; telegramMessageId: string },
      outcome:
        | { status: "applied"; messageId: string; unchanged: boolean }
        | { status: "failed" | "unknown"; code: string; retryAfter?: string },
    ) {
      return db
        .transaction(() => {
          assertLease(claim.leaseOwner ?? "");
          const edit = get(claim.id);
          if (
            edit?.status !== "sending" ||
            edit.attempts !== claim.attempts ||
            edit.leaseOwner !== claim.leaseOwner
          )
            return false;
          const at = now().toISOString();
          if (outcome.status === "applied") {
            const current = message(edit.deliveryId, claim.chatId);
            if (
              outcome.messageId !== current.telegramMessageId ||
              current.version !== edit.expectedVersion
            )
              throw new MessageEditConflictError("The edit receipt does not match this revision.");
            db.query("INSERT INTO core_message_revisions VALUES(?,?,?,?,?)").run(
              current.id,
              current.version + 1,
              edit.text,
              at,
              edit.id,
            );
            db.query(
              "UPDATE core_conversation_outbox SET text=?,text_version=text_version+1 WHERE id=?",
            ).run(edit.text, current.id);
            const chunks = db
              .query<{ text: string }, [string]>(
                "SELECT text FROM core_conversation_outbox WHERE turn_id=? ORDER BY sequence",
              )
              .all(current.turnId);
            db.query("UPDATE core_conversation_turns SET output_text=? WHERE id=?").run(
              chunks.map((c) => c.text).join(""),
              current.turnId,
            );
          }
          db.query(
            "UPDATE core_message_edits SET status=?,failure_code=?,retry_after=?,receipt_json=?,updated_at=? WHERE id=?",
          ).run(
            outcome.status,
            outcome.status === "applied" ? null : outcome.code,
            outcome.status === "applied" ? null : (outcome.retryAfter ?? null),
            JSON.stringify(outcome),
            at,
            edit.id,
          );
          db.query(
            "UPDATE core_message_edit_attempts SET outcome_json=?,finished_at=? WHERE edit_id=? AND attempt=? AND outcome_json IS NULL",
          ).run(JSON.stringify(outcome), at, edit.id, edit.attempts);
          activity.append({
            kind: "conversation.edit_result",
            summary:
              outcome.status === "applied"
                ? "Telegram confirmed a reply edit; conversation history now uses that revision."
                : "A reply edit was not confirmed. The last confirmed history is retained.",
            status: outcome.status === "applied" ? "succeeded" : "failed",
            metadata: { editId: edit.id, outcome: outcome.status },
          });
          return true;
        })
        .immediate();
    },
    recover(leaseOwner: string) {
      db.transaction(() => {
        assertLease(leaseOwner);
        db.query(`UPDATE core_message_edit_attempts SET outcome_json=?,finished_at=?
          WHERE outcome_json IS NULL AND edit_id IN (SELECT id FROM core_message_edits WHERE status='sending')`).run(
          JSON.stringify({ status: "unknown", code: "process_interrupted" }),
          now().toISOString(),
        );
        db.query(
          "UPDATE core_message_edits SET status='unknown',failure_code='process_interrupted',updated_at=? WHERE status='sending'",
        ).run(now().toISOString());
      }).immediate();
    },
  };
}
