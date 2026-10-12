import type { Database } from "bun:sqlite";

/** A scheduled delivery is assistant evidence only after its actual Telegram receipt. */
export function migrateScheduledArchive(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("019-scheduled-history")) return;
    db.exec(`
      INSERT OR IGNORE INTO core_conversation_search(id,turn_id,role,text,observed_at)
        SELECT 'scheduled:'||id,id,'assistant',text,delivered_at FROM core_scheduled_occurrences
        WHERE telegram_message_id IS NOT NULL AND delivered_at IS NOT NULL AND text IS NOT NULL;
      CREATE TRIGGER core_scheduled_delivery_search
        AFTER UPDATE OF telegram_message_id,delivered_at,text ON core_scheduled_occurrences
        WHEN new.telegram_message_id IS NOT NULL AND new.delivered_at IS NOT NULL AND new.text IS NOT NULL BEGIN
          INSERT OR IGNORE INTO core_conversation_search(id,turn_id,role,text,observed_at)
            VALUES('scheduled:'||new.id,new.id,'assistant',new.text,new.delivered_at);
        END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "019-scheduled-history",
      new Date().toISOString(),
    );
  }).immediate();
}
