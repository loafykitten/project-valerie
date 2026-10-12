import type { Database } from "bun:sqlite";

/** Proactive messages become assistant evidence only after a confirmed delivery. */
export function migrateHeartbeatArchive(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT id FROM core_migrations WHERE id=?").get("012-heartbeat-history")) return;
    db.exec(`
      INSERT OR IGNORE INTO core_conversation_search(id,turn_id,role,text,observed_at)
        SELECT 'heartbeat:'||id,id,'assistant',text,delivered_at
        FROM core_heartbeat_runs WHERE status='delivered';
      CREATE TRIGGER core_heartbeat_delivery_search AFTER UPDATE OF status ON core_heartbeat_runs
        WHEN new.status='delivered' AND old.status!='delivered' BEGIN
        INSERT OR IGNORE INTO core_conversation_search(id,turn_id,role,text,observed_at)
          VALUES('heartbeat:'||new.id,new.id,'assistant',new.text,new.delivered_at);
        END;
    `);
    db.query("INSERT INTO core_migrations(id,applied_at) VALUES(?,?)").run(
      "012-heartbeat-history",
      new Date().toISOString(),
    );
  }).immediate();
}
