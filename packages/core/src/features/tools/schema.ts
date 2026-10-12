import type { Database } from "bun:sqlite";

/** Durable provider rounds and outcomes are private conversation evidence. */
export function migrateConversationToolsSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("009-conversation-tools"))
      return;
    db.exec(`
      CREATE TABLE core_tool_rounds (
        turn_id TEXT NOT NULL REFERENCES core_conversation_turns(id),
        round INTEGER NOT NULL CHECK(round >= 0 AND round < 6),
        completion_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(turn_id, round)
      );
      CREATE TABLE core_tool_outcomes (
        turn_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        call_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('read','local_write','external_write','rejected')),
        outcome_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(turn_id, round, call_index),
        FOREIGN KEY(turn_id, round) REFERENCES core_tool_rounds(turn_id, round)
      );
      CREATE TRIGGER core_tool_rounds_immutable BEFORE UPDATE ON core_tool_rounds
        BEGIN SELECT RAISE(ABORT, 'Tool rounds are immutable.'); END;
      CREATE TRIGGER core_tool_outcomes_immutable BEFORE UPDATE ON core_tool_outcomes
        BEGIN SELECT RAISE(ABORT, 'Tool outcomes are immutable.'); END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
      "009-conversation-tools",
      new Date().toISOString(),
    );
  }).immediate();
}
