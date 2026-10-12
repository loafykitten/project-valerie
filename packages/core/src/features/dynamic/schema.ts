import type { Database } from "bun:sqlite";

export function migrateDynamicSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("013-dynamic-details")) return;
    db.exec(`
      CREATE TABLE core_dynamic_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        version INTEGER NOT NULL CHECK(version>=1),
        settings_json TEXT NOT NULL
      );
      CREATE TABLE core_dynamic_settings_revisions (
        version INTEGER PRIMARY KEY CHECK(version>=1),
        settings_json TEXT NOT NULL
      );
      CREATE TABLE core_growth_focus (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK(version>=1),
        state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX core_growth_focus_current ON core_growth_focus((1))
        WHERE state IN ('active','paused');
      CREATE TABLE core_growth_focus_revisions (
        id TEXT NOT NULL REFERENCES core_growth_focus(id),
        version INTEGER NOT NULL CHECK(version>=1),
        record_json TEXT NOT NULL,
        PRIMARY KEY(id,version)
      );
      CREATE TABLE core_dynamic_progress_notes (
        id TEXT PRIMARY KEY,
        focus_id TEXT NOT NULL REFERENCES core_growth_focus(id),
        supersedes_note_id TEXT UNIQUE REFERENCES core_dynamic_progress_notes(id),
        record_json TEXT NOT NULL
      );
      CREATE INDEX core_dynamic_progress_focus ON core_dynamic_progress_notes(focus_id);
      CREATE TABLE core_dynamic_operations (
        operation_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TRIGGER core_growth_focus_archived_immutable BEFORE UPDATE ON core_growth_focus
        WHEN old.state='archived'
        BEGIN SELECT RAISE(ABORT,'Archived focus records are immutable.'); END;
      CREATE TRIGGER core_growth_focus_retained BEFORE DELETE ON core_growth_focus
        BEGIN SELECT RAISE(ABORT,'Growth Focus history is retained.'); END;
    `);
    for (const table of [
      "core_dynamic_settings_revisions",
      "core_growth_focus_revisions",
      "core_dynamic_progress_notes",
      "core_dynamic_operations",
    ]) {
      db.exec(`
        CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
          BEGIN SELECT RAISE(ABORT,'Dynamic Details evidence is immutable.'); END;
        CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT,'Dynamic Details evidence is retained.'); END;
      `);
    }
    const now = new Date().toISOString();
    const settings = JSON.stringify({
      version: 1,
      allowValerieManageFocus: false,
      allowValerieLogNotes: false,
      updatedAt: now,
    });
    db.query("INSERT INTO core_dynamic_settings VALUES(1,1,?)").run(settings);
    db.query("INSERT INTO core_dynamic_settings_revisions VALUES(1,?)").run(settings);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "013-dynamic-details",
      now,
    );
  }).immediate();
}
