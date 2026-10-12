import type { Database } from "bun:sqlite";

export function migrateHeartbeatSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("011-heartbeats")) return;
    db.exec(`
      CREATE TABLE core_heartbeat_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        version INTEGER NOT NULL CHECK(version>=1),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE core_heartbeat_settings_revisions (
        version INTEGER PRIMARY KEY CHECK(version>=1),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TRIGGER core_heartbeat_revision_immutable BEFORE UPDATE ON core_heartbeat_settings_revisions
        BEGIN SELECT RAISE(ABORT,'Heartbeat settings revisions are immutable.'); END;
      CREATE TRIGGER core_heartbeat_revision_retained BEFORE DELETE ON core_heartbeat_settings_revisions
        BEGIN SELECT RAISE(ABORT,'Heartbeat settings revisions are retained.'); END;
      CREATE TABLE core_heartbeat_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        next_opportunity_at TEXT
      );
      INSERT INTO core_heartbeat_state(singleton) VALUES(1);
      CREATE TABLE core_heartbeat_runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('generating','prepared','sending','delivered','unknown','failed','silent','suppressed')),
        fence TEXT NOT NULL UNIQUE,
        lease_owner TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        input_watermark INTEGER NOT NULL CHECK(input_watermark>=0),
        waking_day TEXT NOT NULL,
        snapshot_json TEXT,
        text TEXT,
        result_json TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        delivery_started_at TEXT,
        delivered_at TEXT,
        telegram_message_id TEXT
      );
      CREATE UNIQUE INDEX core_heartbeat_single_active ON core_heartbeat_runs((1))
        WHERE status IN ('generating','prepared','sending');
      CREATE INDEX core_heartbeat_history ON core_heartbeat_runs(chat_id,status,delivered_at);
      CREATE INDEX core_heartbeat_unanswered ON core_heartbeat_runs(chat_id,status,input_watermark);
      CREATE INDEX core_heartbeat_recent ON core_heartbeat_runs(created_at DESC);
      CREATE TRIGGER core_heartbeat_snapshot_immutable BEFORE UPDATE OF snapshot_json ON core_heartbeat_runs
        WHEN old.snapshot_json IS NOT NULL AND new.snapshot_json IS NOT old.snapshot_json
        BEGIN SELECT RAISE(ABORT,'Heartbeat snapshots are immutable.'); END;
      CREATE TRIGGER core_heartbeat_text_immutable BEFORE UPDATE OF text ON core_heartbeat_runs
        WHEN old.text IS NOT NULL AND new.text IS NOT old.text
        BEGIN SELECT RAISE(ABORT,'Prepared heartbeat messages are immutable.'); END;
      CREATE TRIGGER core_heartbeat_result_immutable BEFORE UPDATE OF result_json ON core_heartbeat_runs
        WHEN old.result_json IS NOT NULL AND new.result_json IS NOT old.result_json
        BEGIN SELECT RAISE(ABORT,'Heartbeat generation evidence is immutable.'); END;
      CREATE TRIGGER core_heartbeat_request_immutable
        BEFORE UPDATE OF id,chat_id,fence,lease_owner,settings_json,input_watermark,created_at ON core_heartbeat_runs
        BEGIN SELECT RAISE(ABORT,'Heartbeat opportunity identity is immutable.'); END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "011-heartbeats",
      new Date().toISOString(),
    );
  }).immediate();
}
