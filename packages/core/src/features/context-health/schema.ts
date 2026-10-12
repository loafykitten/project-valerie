import type { Database } from "bun:sqlite";

/** Old receipts stay unknown; no historical tier or billed amount is inferred. */
export function migrateInferenceReceipts(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("021-inference-receipts")) return;
    db.exec(`
      ALTER TABLE core_context_requests ADD COLUMN service_tier TEXT
        CHECK(service_tier IN ('flex','standard'));
      ALTER TABLE core_context_requests ADD COLUMN cost_usd REAL CHECK(cost_usd>=0);
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "021-inference-receipts",
      new Date().toISOString(),
    );
  }).immediate();
}

/** One receipt per actual provider invocation; message bodies remain in their owning archive. */
export function migrateContextHealthSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("014-context-health")) return;
    db.exec(`
      CREATE TABLE core_context_requests (
        id TEXT PRIMARY KEY,
        turn_id TEXT REFERENCES core_conversation_turns(id),
        heartbeat_run_id TEXT REFERENCES core_heartbeat_runs(id),
        attempt INTEGER NOT NULL CHECK(attempt>=1),
        started_at TEXT NOT NULL,
        elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms>=0),
        request_id TEXT,
        finish_reason TEXT CHECK(finish_reason IN ('stop','length','tool_calls')),
        failure_code TEXT,
        input_tokens INTEGER CHECK(input_tokens>=0),
        output_tokens INTEGER CHECK(output_tokens>=0),
        cached_input_tokens INTEGER CHECK(cached_input_tokens>=0),
        reasoning_tokens INTEGER CHECK(reasoning_tokens>=0),
        message_units INTEGER NOT NULL CHECK(message_units>=0),
        tool_schema_units INTEGER NOT NULL CHECK(tool_schema_units>=0),
        created_at TEXT NOT NULL,
        CHECK((turn_id IS NOT NULL) + (heartbeat_run_id IS NOT NULL) = 1),
        CHECK((finish_reason IS NOT NULL) + (failure_code IS NOT NULL) = 1)
      );
      CREATE INDEX core_context_requests_turn ON core_context_requests(turn_id,started_at);
      CREATE INDEX core_context_requests_heartbeat ON core_context_requests(heartbeat_run_id,started_at);
      CREATE INDEX core_context_turns_received ON core_conversation_turns(received_at DESC,id);
      CREATE INDEX core_context_tool_pressure ON core_activity(json_extract(metadata_json,'$.turnId'))
        WHERE kind='context.tool_budget';
      CREATE TRIGGER core_context_requests_immutable BEFORE UPDATE ON core_context_requests
        BEGIN SELECT RAISE(ABORT,'Context request receipts are immutable.'); END;
      CREATE TRIGGER core_context_requests_retained BEFORE DELETE ON core_context_requests
        BEGIN SELECT RAISE(ABORT,'Context request receipts are retained.'); END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "014-context-health",
      new Date().toISOString(),
    );
  }).immediate();
}
