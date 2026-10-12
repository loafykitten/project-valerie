import type { Database } from "bun:sqlite";

export function migrateReminderSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("018-reminders")) return;
    db.exec(`
      ALTER TABLE core_context_requests ADD COLUMN tool_catalog_json TEXT;
      CREATE TABLE core_reminders (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL,
        current_occurrence_id TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE TABLE core_reminder_revisions (
        reminder_id TEXT NOT NULL REFERENCES core_reminders(id), version INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(reminder_id,version)
      );
      CREATE TABLE core_scheduled_occurrences (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('explicit_reminder','checkin')),
        reminder_id TEXT REFERENCES core_reminders(id), reminder_version INTEGER,
        chat_id TEXT, input_watermark INTEGER NOT NULL DEFAULT 0, due_at TEXT NOT NULL, earliest_at TEXT NOT NULL, expires_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('scheduled','generating','prepared','sending','retry','sent','silent','suppressed','failed','unknown','cancelled','expired')),
        title TEXT NOT NULL, purpose TEXT NOT NULL, timezone TEXT NOT NULL, allow_fallback INTEGER NOT NULL,
        checkin_json TEXT, fence TEXT, lease_owner TEXT, snapshot_json TEXT, result_json TEXT,
        text TEXT, used_fallback INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, telegram_message_id TEXT, delivered_at TEXT, reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX core_scheduled_due ON core_scheduled_occurrences(status,due_at);
      CREATE INDEX core_scheduled_parent ON core_scheduled_occurrences(reminder_id,created_at);
      CREATE TABLE core_scheduled_generations (
        occurrence_id TEXT NOT NULL REFERENCES core_scheduled_occurrences(id), fence TEXT NOT NULL,
        lease_owner TEXT NOT NULL, snapshot_json TEXT, result_json TEXT, failure_code TEXT,
        started_at TEXT NOT NULL, finished_at TEXT, PRIMARY KEY(occurrence_id,fence)
      );
      CREATE TABLE core_scheduled_deliveries (
        occurrence_id TEXT NOT NULL REFERENCES core_scheduled_occurrences(id), attempt INTEGER NOT NULL,
        fence TEXT NOT NULL, lease_owner TEXT NOT NULL, started_at TEXT NOT NULL,
        outcome_json TEXT, late_receipt_json TEXT, finished_at TEXT, PRIMARY KEY(occurrence_id,attempt)
      );
      CREATE TABLE core_checkin_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, settings_json TEXT NOT NULL
      );
      CREATE TABLE core_checkin_settings_revisions (
        version INTEGER PRIMARY KEY, settings_json TEXT NOT NULL
      );
      CREATE TABLE core_checkin_state (
        chat_id TEXT PRIMARY KEY, daily_revision TEXT NOT NULL, agreement_revision TEXT NOT NULL,
        input_watermark INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE core_checkin_slots (
        day_id TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('morning','evening')),
        occurrence_id TEXT REFERENCES core_scheduled_occurrences(id), attempts INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0, covered_keys_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL, PRIMARY KEY(day_id,slot)
      );
      CREATE TRIGGER core_scheduled_text_immutable BEFORE UPDATE OF text ON core_scheduled_occurrences
        WHEN OLD.text IS NOT NULL AND NEW.text IS NOT OLD.text
        BEGIN SELECT RAISE(ABORT,'Prepared scheduled text is immutable.'); END;
      CREATE TRIGGER core_scheduled_snapshot_immutable BEFORE UPDATE OF snapshot_json ON core_scheduled_occurrences
        WHEN OLD.snapshot_json IS NOT NULL AND NEW.snapshot_json IS NOT OLD.snapshot_json
        BEGIN SELECT RAISE(ABORT,'Scheduled snapshots are immutable.'); END;
      CREATE TRIGGER core_scheduled_result_immutable BEFORE UPDATE OF result_json ON core_scheduled_occurrences
        WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
        BEGIN SELECT RAISE(ABORT,'Scheduled results are immutable.'); END;
      CREATE TRIGGER core_generation_snapshot_immutable BEFORE UPDATE OF snapshot_json ON core_scheduled_generations
        WHEN OLD.snapshot_json IS NOT NULL AND NEW.snapshot_json IS NOT OLD.snapshot_json
        BEGIN SELECT RAISE(ABORT,'Generation snapshots are immutable.'); END;
      CREATE TRIGGER core_generation_result_immutable BEFORE UPDATE OF result_json ON core_scheduled_generations
        WHEN OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json
        BEGIN SELECT RAISE(ABORT,'Generation receipts are immutable.'); END;
      CREATE TRIGGER core_scheduled_delivery_immutable BEFORE UPDATE OF outcome_json ON core_scheduled_deliveries
        WHEN OLD.outcome_json IS NOT NULL AND NEW.outcome_json IS NOT OLD.outcome_json
        BEGIN SELECT RAISE(ABORT,'Delivery receipts are immutable.'); END;
      CREATE TRIGGER core_scheduled_late_receipt_immutable BEFORE UPDATE OF late_receipt_json ON core_scheduled_deliveries
        WHEN OLD.late_receipt_json IS NOT NULL AND NEW.late_receipt_json IS NOT OLD.late_receipt_json
        BEGIN SELECT RAISE(ABORT,'Late delivery receipts are immutable.'); END;
    `);
    for (const table of ["core_reminder_revisions", "core_checkin_settings_revisions"]) {
      db.exec(
        `CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Revisions are immutable.'); END;`,
      );
    }
    for (const table of [
      "core_reminders",
      "core_reminder_revisions",
      "core_scheduled_occurrences",
      "core_scheduled_generations",
      "core_scheduled_deliveries",
      "core_checkin_settings_revisions",
    ]) {
      db.exec(
        `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Scheduling evidence is retained.'); END;`,
      );
    }
    const timestamp = new Date().toISOString();
    const settings = JSON.stringify({
      version: 1,
      enabled: false,
      morningDelayMinutes: 30,
      eveningLeadMinutes: 120,
      minIdleMinutes: 15,
      maxMessageChars: 480,
      updatedAt: timestamp,
    });
    db.query("INSERT INTO core_checkin_settings VALUES(1,1,?)").run(settings);
    db.query("INSERT INTO core_checkin_settings_revisions VALUES(1,?)").run(settings);
    db.query("INSERT INTO core_migrations VALUES(?,?)").run("018-reminders", timestamp);
  }).immediate();
}
