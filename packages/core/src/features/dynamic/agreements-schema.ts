import type { Database } from "bun:sqlite";

export function migrateAgreementsSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("017-agreements")) return;
    db.exec(`
      CREATE TABLE core_habits(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),record_json TEXT NOT NULL);
      CREATE TABLE core_habit_revisions(id TEXT NOT NULL REFERENCES core_habits(id),version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE core_habit_opportunities(id TEXT PRIMARY KEY,habit_id TEXT NOT NULL REFERENCES core_habits(id),day_id TEXT NOT NULL REFERENCES core_waking_days(id),version INTEGER NOT NULL,definition_version INTEGER NOT NULL,record_json TEXT NOT NULL,UNIQUE(habit_id,day_id));
      CREATE INDEX core_habit_opportunities_day ON core_habit_opportunities(day_id);
      CREATE TABLE core_habit_opportunity_revisions(id TEXT NOT NULL REFERENCES core_habit_opportunities(id),version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE core_habit_variants(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','voided')),opportunity_id TEXT NOT NULL REFERENCES core_habit_opportunities(id),event_id TEXT NOT NULL REFERENCES core_dynamic_events(id),record_json TEXT NOT NULL);
      CREATE UNIQUE INDEX core_habit_variant_active ON core_habit_variants(opportunity_id,event_id) WHERE state='active';
      CREATE TABLE core_habit_variant_revisions(id TEXT NOT NULL REFERENCES core_habit_variants(id),version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE core_rules(id TEXT PRIMARY KEY,version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','paused','archived')),record_json TEXT NOT NULL);
      CREATE TABLE core_rule_revisions(id TEXT NOT NULL REFERENCES core_rules(id),version INTEGER NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE core_rule_notes(id TEXT PRIMARY KEY,rule_id TEXT NOT NULL REFERENCES core_rules(id),fingerprint TEXT NOT NULL UNIQUE,record_json TEXT NOT NULL);
    `);
    for (const table of [
      "core_habit_revisions",
      "core_habit_opportunity_revisions",
      "core_habit_variant_revisions",
      "core_rule_revisions",
      "core_rule_notes",
    ]) {
      db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Agreement history is immutable.'); END;
      CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Agreement history is retained.'); END;`);
    }
    for (const table of [
      "core_habits",
      "core_habit_opportunities",
      "core_habit_variants",
      "core_rules",
    ])
      db.exec(
        `CREATE TRIGGER ${table}_retained BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Agreement records are retained.'); END;`,
      );
    for (const table of ["core_habits", "core_rules"])
      db.exec(
        `CREATE TRIGGER ${table}_archived_immutable BEFORE UPDATE ON ${table} WHEN old.state='archived' BEGIN SELECT RAISE(ABORT,'Archived agreements are immutable.'); END;`,
      );
    const row = db
      .query<{ json: string }, []>(
        "SELECT settings_json AS json FROM core_dynamic_settings WHERE singleton=1",
      )
      .get();
    if (!row) throw new Error("Dynamic settings unavailable.");
    const settings = {
      ...JSON.parse(row.json),
      allowValerieManageHabits: false,
      allowValerieManageRules: false,
      allowValerieManageReminders: false,
    };
    db.query("UPDATE core_dynamic_settings SET settings_json=? WHERE singleton=1").run(
      JSON.stringify(settings),
    );
    db.query("INSERT INTO core_migrations VALUES(?,?)").run(
      "017-agreements",
      new Date().toISOString(),
    );
  }).immediate();
}
