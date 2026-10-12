import type { Database } from "bun:sqlite";

export function migrateMessageEdits(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("020-message-edits")) return;
    db.exec(`
      ALTER TABLE core_conversation_outbox ADD COLUMN text_version INTEGER NOT NULL DEFAULT 1;
      CREATE TABLE core_message_revisions (
        delivery_id TEXT NOT NULL REFERENCES core_conversation_outbox(id),
        version INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
        edit_id TEXT, PRIMARY KEY(delivery_id,version)
      );
      CREATE TABLE core_message_edits (
        id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES core_conversation_outbox(id),
        expected_version INTEGER NOT NULL, text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','sending','applied','failed','unknown')),
        attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, failure_code TEXT,
        retry_after TEXT, receipt_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX core_message_edit_open ON core_message_edits(delivery_id)
        WHERE status IN ('queued','sending','unknown');
      CREATE INDEX core_message_edit_queue ON core_message_edits(status,created_at);
      CREATE TABLE core_message_edit_attempts (
        edit_id TEXT NOT NULL REFERENCES core_message_edits(id), attempt INTEGER NOT NULL,
        lease_owner TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, outcome_json TEXT,
        PRIMARY KEY(edit_id,attempt)
      );
      CREATE TRIGGER core_message_edit_attempt_immutable BEFORE UPDATE ON core_message_edit_attempts
        WHEN OLD.outcome_json IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'Edit attempt receipts are immutable.'); END;
      CREATE TRIGGER core_message_edit_attempt_retained BEFORE DELETE ON core_message_edit_attempts
        BEGIN SELECT RAISE(ABORT,'Edit attempt receipts are retained.'); END;
      CREATE TRIGGER core_message_revision_immutable BEFORE UPDATE ON core_message_revisions
        BEGIN SELECT RAISE(ABORT,'Message revisions are immutable.'); END;
      CREATE TRIGGER core_message_revision_retained BEFORE DELETE ON core_message_revisions
        BEGIN SELECT RAISE(ABORT,'Message revisions are retained.'); END;
      CREATE TRIGGER core_message_edit_request_immutable
        BEFORE UPDATE OF delivery_id,expected_version,text,created_at ON core_message_edits
        BEGIN SELECT RAISE(ABORT,'Edit requests are immutable.'); END;
      CREATE TRIGGER core_message_edit_retained BEFORE DELETE ON core_message_edits
        BEGIN SELECT RAISE(ABORT,'Edit receipts are retained.'); END;
      CREATE TRIGGER core_conversation_search_edit AFTER UPDATE OF text ON core_conversation_search BEGIN
        DELETE FROM core_conversation_fts WHERE id=old.id;
        INSERT INTO core_conversation_fts(id,text) VALUES(new.id,new.text);
      END;
      CREATE TRIGGER core_conversation_delivery_edit AFTER UPDATE OF text ON core_conversation_outbox
        WHEN new.status='sent' BEGIN
        UPDATE core_conversation_search SET text=new.text WHERE id='delivery:'||new.id;
      END;
    `);
    db.query("INSERT INTO core_migrations VALUES(?,?)").run(
      "020-message-edits",
      new Date().toISOString(),
    );
  }).immediate();
}
