import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateContextNoticeSchema } from "./features/context-health/notices";
import {
  migrateContextHealthSchema,
  migrateInferenceReceipts,
} from "./features/context-health/schema";
import { migrateMessageEdits } from "./features/conversations/edit-schema";
import { migrateAgreementsSchema } from "./features/dynamic/agreements-schema";
import { migrateDailySchema } from "./features/dynamic/daily-schema";
import { migrateDynamicSchema } from "./features/dynamic/schema";
import { migrateHeartbeatArchive } from "./features/heartbeat/archive";
import { migrateHeartbeatSchema } from "./features/heartbeat/schema";
import { migrateMemorySchema, migrateMemorySynthesisSchema } from "./features/memory/schema";
import { mergeTtsPrompts } from "./features/prompts/merge-tts";
import { migrateScheduledArchive } from "./features/reminders/archive";
import { migrateReminderSchema } from "./features/reminders/schema";
import { migrateConversationToolsSchema } from "./features/tools/schema";

export interface Store {
  readonly db: Database;
  close(): void;
}

/** Open the durable local store. Schema changes run atomically and only once. */
export function openStore(path: string): Store {
  if (!path) throw new TypeError("A database path is required.");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("001-foundation")) return;
      db.exec(`
        CREATE TABLE core_prompts (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          purpose TEXT NOT NULL,
          content TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE core_prompt_revisions (
          prompt_id TEXT NOT NULL REFERENCES core_prompts(id),
          version INTEGER NOT NULL CHECK (version >= 1),
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (prompt_id, version)
        );
        CREATE TABLE core_activity (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          summary TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'pending')),
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE INDEX core_activity_created ON core_activity(created_at DESC);
        CREATE INDEX core_activity_status ON core_activity(status, created_at DESC);
      `);
      db.query("INSERT INTO core_migrations (id, applied_at) VALUES (?, ?)").run(
        "001-foundation",
        new Date().toISOString(),
      );
    }).immediate();

    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("002-character-import"))
        return;
      db.exec(`
        CREATE TABLE core_character_imports (
          id TEXT PRIMARY KEY,
          sha256 TEXT NOT NULL UNIQUE,
          original_bytes BLOB NOT NULL,
          json_text TEXT NOT NULL,
          source_name TEXT,
          display_name TEXT NOT NULL,
          source_filename TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          format TEXT NOT NULL CHECK (format IN ('png', 'json')),
          metadata_keyword TEXT CHECK (metadata_keyword IN ('chara', 'ccv3')),
          mappings_json TEXT NOT NULL,
          preserved_only_json TEXT NOT NULL
        );
        CREATE TABLE core_character_active (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          import_id TEXT NOT NULL REFERENCES core_character_imports(id)
        );
        CREATE TRIGGER core_character_imports_immutable_update
          BEFORE UPDATE ON core_character_imports
          BEGIN SELECT RAISE(ABORT, 'Character import sources are immutable.'); END;
        CREATE TRIGGER core_character_imports_immutable_delete
          BEFORE DELETE ON core_character_imports
          BEGIN SELECT RAISE(ABORT, 'Character import sources are immutable.'); END;
      `);
      db.query("INSERT INTO core_migrations (id, applied_at) VALUES (?, ?)").run(
        "002-character-import",
        new Date().toISOString(),
      );
    }).immediate();
    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("003-prompt-order")) return;
      db.exec(`
        CREATE TABLE core_prompt_order (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          ids_json TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          updated_at TEXT NOT NULL
        );
      `);
      const now = new Date().toISOString();
      db.query(
        "INSERT INTO core_prompt_order (singleton, ids_json, version, updated_at) VALUES (1, '[]', 1, ?)",
      ).run(now);
      db.query("INSERT INTO core_migrations (id, applied_at) VALUES (?, ?)").run(
        "003-prompt-order",
        now,
      );
    }).immediate();
    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("004-shared-tts")) return;
      mergeTtsPrompts(db);
      db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
        "004-shared-tts",
        new Date().toISOString(),
      );
    }).immediate();
    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("005-conversations")) return;
      db.exec(`
        CREATE TABLE core_inference_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version >= 1),
          settings_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE core_inference_settings_revisions (
          version INTEGER PRIMARY KEY,
          settings_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE core_telegram_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_offset INTEGER NOT NULL DEFAULT 0,
          bot_id TEXT,
          lease_owner TEXT,
          lease_expires_at TEXT
        );
        INSERT INTO core_telegram_state(singleton) VALUES (1);
        CREATE TABLE core_conversation_turns (
          id TEXT PRIMARY KEY,
          update_id INTEGER NOT NULL UNIQUE,
          message_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          input_text TEXT NOT NULL,
          received_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued','generating','retry','generated','delivered','failed','unknown')),
          snapshot_json TEXT,
          output_text TEXT,
          result_json TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          failure_code TEXT,
          completed_at TEXT,
          UNIQUE(chat_id, message_id)
        );
        CREATE INDEX core_conversation_pending ON core_conversation_turns(status, received_at);
        CREATE INDEX core_conversation_history ON core_conversation_turns(chat_id, received_at DESC);
        CREATE TRIGGER core_turn_snapshot_immutable
          BEFORE UPDATE OF snapshot_json ON core_conversation_turns
          WHEN OLD.snapshot_json IS NOT NULL AND NEW.snapshot_json IS NOT OLD.snapshot_json
          BEGIN SELECT RAISE(ABORT, 'Turn snapshots are immutable.'); END;
        CREATE TABLE core_conversation_results (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES core_conversation_turns(id),
          attempt INTEGER NOT NULL,
          output_text TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX core_conversation_results_turn ON core_conversation_results(turn_id);
        CREATE TABLE core_conversation_outbox (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES core_conversation_turns(id),
          sequence INTEGER NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued','sending','retry','sent','failed','unknown','cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          telegram_message_id TEXT,
          failure_code TEXT,
          delivered_at TEXT,
          UNIQUE(turn_id, sequence)
        );
        CREATE INDEX core_conversation_delivery ON core_conversation_outbox(status, next_attempt_at);
      `);
      db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
        "005-conversations",
        new Date().toISOString(),
      );
    }).immediate();
    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("006-conversation-images"))
        return;
      db.exec(`
        ALTER TABLE core_conversation_turns ADD COLUMN media_group_id TEXT;
        ALTER TABLE core_conversation_turns ADD COLUMN album_started_at TEXT;
        ALTER TABLE core_conversation_turns ADD COLUMN album_ready_at TEXT;
        CREATE INDEX core_conversation_albums ON core_conversation_turns(chat_id, media_group_id, status);
        CREATE TABLE core_telegram_inputs (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES core_conversation_turns(id),
          update_id INTEGER NOT NULL UNIQUE,
          message_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          input_text TEXT NOT NULL,
          received_at TEXT NOT NULL,
          media_group_id TEXT,
          rejection_code TEXT,
          UNIQUE(chat_id, message_id)
        );
        CREATE INDEX core_telegram_inputs_turn ON core_telegram_inputs(turn_id);
        INSERT INTO core_telegram_inputs(id,turn_id,update_id,message_id,chat_id,sender_id,input_text,received_at)
          SELECT id,id,update_id,message_id,chat_id,sender_id,input_text,received_at FROM core_conversation_turns;
        CREATE TABLE core_conversation_attachments (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL REFERENCES core_conversation_turns(id),
          input_id TEXT NOT NULL REFERENCES core_telegram_inputs(id),
          sequence INTEGER NOT NULL,
          telegram_file_id TEXT NOT NULL,
          telegram_file_unique_id TEXT NOT NULL,
          declared_mime_type TEXT,
          declared_size INTEGER,
          status TEXT NOT NULL CHECK(status IN ('pending','downloading','retry','ready','failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          failure_code TEXT,
          mime_type TEXT,
          width INTEGER,
          height INTEGER,
          byte_size INTEGER,
          sha256 TEXT,
          original_bytes BLOB,
          created_at TEXT NOT NULL,
          UNIQUE(input_id, sequence)
        );
        CREATE INDEX core_conversation_attachments_turn ON core_conversation_attachments(turn_id,status);
        CREATE TRIGGER core_conversation_attachment_immutable
          BEFORE UPDATE OF original_bytes, mime_type, width, height, byte_size, sha256 ON core_conversation_attachments
          WHEN OLD.original_bytes IS NOT NULL
          BEGIN SELECT RAISE(ABORT, 'Archived images are immutable.'); END;
        CREATE TRIGGER core_conversation_attachment_retained
          BEFORE DELETE ON core_conversation_attachments
          BEGIN SELECT RAISE(ABORT, 'Archived images must be retained.'); END;
      `);
      db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
        "006-conversation-images",
        new Date().toISOString(),
      );
    }).immediate();
    db.transaction(() => {
      if (db.query("SELECT id FROM core_migrations WHERE id = ?").get("007-image-generation"))
        return;
      db.exec(`
        CREATE TABLE core_image_jobs (
          id TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL UNIQUE REFERENCES core_conversation_turns(id),
          tool_call_id TEXT NOT NULL,
          invocation_json TEXT,
          framing TEXT NOT NULL CHECK(framing IN ('selfie','full_body')),
          scene_tags_json TEXT NOT NULL,
          prompt TEXT NOT NULL,
          workflow_json TEXT NOT NULL,
          seed INTEGER NOT NULL CHECK(seed >= 0 AND seed <= 4294967295),
          prompt_id TEXT NOT NULL UNIQUE,
          submitted_prompt_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('queued','submitting','running','recovery','ready','sending','sent','failed','unknown')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          deadline_at TEXT,
          failure_code TEXT,
          delivery_attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          telegram_message_id TEXT,
          delivered_at TEXT
        );
        CREATE INDEX core_image_jobs_pending ON core_image_jobs(status, created_at);
        CREATE UNIQUE INDEX core_image_jobs_single_render ON core_image_jobs((1))
          WHERE status IN ('submitting','running','recovery');
        CREATE TRIGGER core_image_job_request_immutable
          BEFORE UPDATE OF turn_id,tool_call_id,invocation_json,framing,scene_tags_json,prompt,workflow_json,seed,prompt_id ON core_image_jobs
          BEGIN SELECT RAISE(ABORT, 'Image requests are immutable.'); END;
        CREATE TABLE core_generated_images (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL UNIQUE REFERENCES core_image_jobs(id),
          original_bytes BLOB NOT NULL,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
          width INTEGER NOT NULL CHECK(width > 0),
          height INTEGER NOT NULL CHECK(height > 0),
          byte_size INTEGER NOT NULL CHECK(byte_size > 0),
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TRIGGER core_generated_images_immutable
          BEFORE UPDATE ON core_generated_images
          BEGIN SELECT RAISE(ABORT, 'Generated images are immutable.'); END;
        CREATE TRIGGER core_generated_images_retained
          BEFORE DELETE ON core_generated_images
          BEGIN SELECT RAISE(ABORT, 'Generated images must be retained.'); END;
        CREATE TABLE core_image_failure_notices (
          job_id TEXT PRIMARY KEY REFERENCES core_image_jobs(id),
          status TEXT NOT NULL CHECK(status IN ('pending','generating','ready','sending','sent','failed','unknown')),
          text TEXT,
          result_json TEXT,
          failure_code TEXT,
          telegram_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE TRIGGER core_image_notice_text_immutable
          BEFORE UPDATE OF text ON core_image_failure_notices
          WHEN OLD.text IS NOT NULL AND NEW.text IS NOT OLD.text
          BEGIN SELECT RAISE(ABORT, 'Image failure notice text is immutable.'); END;
      `);
      db.query("INSERT INTO core_migrations(id,applied_at) VALUES (?,?)").run(
        "007-image-generation",
        new Date().toISOString(),
      );
    }).immediate();
    migrateMemorySchema(db);
    migrateConversationToolsSchema(db);
    migrateMemorySynthesisSchema(db);
    migrateHeartbeatSchema(db);
    migrateHeartbeatArchive(db);
    migrateDynamicSchema(db);
    migrateContextHealthSchema(db);
    migrateContextNoticeSchema(db);
    migrateDailySchema(db);
    migrateAgreementsSchema(db);
    migrateReminderSchema(db);
    migrateScheduledArchive(db);
    migrateMessageEdits(db);
    migrateInferenceReceipts(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return { db, close: () => db.close() };
}
