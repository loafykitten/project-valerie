import type { Database } from "bun:sqlite";

export function migrateMemorySchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("008-memory")) return;
    db.exec(`
      CREATE TABLE core_memory_documents (
        id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('records','vault')),
        source_path TEXT UNIQUE, version INTEGER NOT NULL, tier TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL,
        available INTEGER NOT NULL DEFAULT 1, historical INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT, updated_at TEXT NOT NULL, fingerprint TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX core_memory_active ON core_memory_documents(source,state,available,expires_at);
      CREATE TABLE core_memory_revisions (
        id TEXT NOT NULL, version INTEGER NOT NULL, record_json TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(id,version)
      );
      CREATE TRIGGER core_memory_revision_immutable BEFORE UPDATE ON core_memory_revisions
        BEGIN SELECT RAISE(ABORT,'Memory revisions are immutable.'); END;
      CREATE TRIGGER core_memory_revision_retained BEFORE DELETE ON core_memory_revisions
        BEGIN SELECT RAISE(ABORT,'Memory revisions are retained.'); END;
      CREATE VIRTUAL TABLE core_memory_fts USING fts5(id UNINDEXED,title,body,tokenize='unicode61');
      CREATE TRIGGER core_memory_search_insert AFTER INSERT ON core_memory_documents BEGIN
        INSERT INTO core_memory_fts(id,title,body) VALUES(new.id,new.title,new.body); END;
      CREATE TRIGGER core_memory_search_update AFTER UPDATE OF title,body ON core_memory_documents BEGIN
        DELETE FROM core_memory_fts WHERE id=old.id;
        INSERT INTO core_memory_fts(id,title,body) VALUES(new.id,new.title,new.body); END;
      CREATE TABLE core_memory_operations (operation_key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE core_memory_settings (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
        core_tokens INTEGER NOT NULL, retrieved_tokens INTEGER NOT NULL, topic_tokens INTEGER NOT NULL
      );
      INSERT INTO core_memory_settings VALUES(1,1,1500,2000,750);
      CREATE TABLE core_memory_vault_status (singleton INTEGER PRIMARY KEY CHECK(singleton=1), status_json TEXT NOT NULL);
      CREATE TABLE core_conversation_search (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, role TEXT NOT NULL,
        text TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE core_conversation_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
      CREATE TRIGGER core_conversation_search_index AFTER INSERT ON core_conversation_search BEGIN
        INSERT INTO core_conversation_fts(id,text) VALUES(new.id,new.text); END;
      INSERT INTO core_conversation_search SELECT 'conversation:'||id,turn_id,'user',input_text,received_at FROM core_telegram_inputs;
      INSERT INTO core_conversation_search SELECT 'delivery:'||id,turn_id,'assistant',text,delivered_at FROM core_conversation_outbox WHERE status='sent';
      CREATE TRIGGER core_conversation_input_search AFTER INSERT ON core_telegram_inputs BEGIN
        INSERT INTO core_conversation_search VALUES('conversation:'||new.id,new.turn_id,'user',new.input_text,new.received_at); END;
      CREATE TRIGGER core_conversation_delivery_search AFTER UPDATE OF status ON core_conversation_outbox
        WHEN new.status='sent' AND old.status!='sent' BEGIN
        INSERT OR IGNORE INTO core_conversation_search VALUES('delivery:'||new.id,new.turn_id,'assistant',new.text,new.delivered_at); END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
      "008-memory",
      new Date().toISOString(),
    );
  }).immediate();
}

/** Add searchable interpretation text without changing any retained memory revision. */
export function migrateMemorySynthesisSchema(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("010-memory-synthesis")) return;
    db.exec(`
      DROP TRIGGER core_memory_search_insert;
      DROP TRIGGER core_memory_search_update;
      CREATE TRIGGER core_memory_search_insert AFTER INSERT ON core_memory_documents BEGIN
        INSERT INTO core_memory_fts(id,title,body)
          VALUES(new.id,new.title,new.body||char(10)||coalesce(json_extract(new.record_json,'$.thoughts'),'')); END;
      CREATE TRIGGER core_memory_search_update AFTER UPDATE OF title,body,record_json ON core_memory_documents BEGIN
        DELETE FROM core_memory_fts WHERE id=old.id;
        INSERT INTO core_memory_fts(id,title,body)
          VALUES(new.id,new.title,new.body||char(10)||coalesce(json_extract(new.record_json,'$.thoughts'),'')); END;
      DELETE FROM core_memory_fts;
      INSERT INTO core_memory_fts(id,title,body)
        SELECT id,title,body||char(10)||coalesce(json_extract(record_json,'$.thoughts'),'')
        FROM core_memory_documents;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "010-memory-synthesis",
      new Date().toISOString(),
    );
  }).immediate();
}
