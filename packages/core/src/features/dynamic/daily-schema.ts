import type { Database } from "bun:sqlite";

export function migrateDailySchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("016-daily-records")) return;
    db.exec(`
      ALTER TABLE core_telegram_inputs ADD COLUMN source_metadata_json TEXT;
      CREATE TRIGGER core_input_source_metadata_immutable BEFORE UPDATE OF source_metadata_json ON core_telegram_inputs
        BEGIN SELECT RAISE(ABORT,'Transport provenance is immutable.'); END;
      CREATE TABLE core_waking_days (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=1),
        current INTEGER NOT NULL CHECK(current IN (0,1)), record_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX core_waking_day_current ON core_waking_days((1)) WHERE current=1;
      CREATE TABLE core_waking_day_revisions (
        day_id TEXT NOT NULL REFERENCES core_waking_days(id), version INTEGER NOT NULL,
        causal_event_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(day_id,version)
      );
      CREATE TABLE core_progress_behaviors (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','archived')),
        record_json TEXT NOT NULL
      );
      CREATE TABLE core_progress_behavior_revisions (
        behavior_id TEXT NOT NULL REFERENCES core_progress_behaviors(id), version INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(behavior_id,version)
      );
      CREATE TABLE core_dynamic_events (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>=1),
        state TEXT NOT NULL CHECK(state IN ('active','voided')), kind TEXT NOT NULL,
        day_id TEXT REFERENCES core_waking_days(id), behavior_id TEXT REFERENCES core_progress_behaviors(id),
        occurred_at TEXT, recorded_at TEXT NOT NULL, record_json TEXT NOT NULL
      );
      CREATE INDEX core_daily_event_day ON core_dynamic_events(day_id,recorded_at);
      CREATE INDEX core_daily_event_behavior ON core_dynamic_events(behavior_id,day_id);
      CREATE TABLE core_dynamic_event_revisions (
        event_id TEXT NOT NULL REFERENCES core_dynamic_events(id), version INTEGER NOT NULL,
        record_json TEXT NOT NULL, PRIMARY KEY(event_id,version)
      );
      CREATE TABLE core_dynamic_event_sources (
        source_ref TEXT NOT NULL, claim_key TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES core_dynamic_events(id),
        PRIMARY KEY(source_ref,claim_key)
      );
    `);
    for (const table of [
      "core_waking_day_revisions",
      "core_progress_behavior_revisions",
      "core_dynamic_event_revisions",
      "core_dynamic_event_sources",
    ]) {
      db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Daily evidence is immutable.'); END;
        CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Daily evidence is retained.'); END;`);
    }
    for (const table of ["core_waking_days", "core_progress_behaviors", "core_dynamic_events"])
      db.exec(
        `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Daily history is retained.'); END;`,
      );
    const row = db
      .query<{ json: string }, []>(
        "SELECT settings_json AS json FROM core_dynamic_settings WHERE singleton=1",
      )
      .get();
    if (!row) throw new Error("Dynamic settings missing.");
    const prior = JSON.parse(row.json);
    // Missing scopes already mean false. Materializing those defaults does not
    // grant authority or rewrite retained permission revisions.
    const updated = {
      ...prior,
      allowValerieManageWaking: false,
      allowValerieManageProgress: false,
    };
    db.query("UPDATE core_dynamic_settings SET settings_json=? WHERE singleton=1").run(
      JSON.stringify(updated),
    );
    db.query("INSERT INTO core_migrations VALUES(?,?)").run(
      "016-daily-records",
      new Date().toISOString(),
    );
  }).immediate();
}
