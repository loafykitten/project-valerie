import type { Database } from "bun:sqlite";

const telegramOpening = "Write the words to be spoken in a Telegram voice note.";
const desktopOpening = "Write the words to be spoken aloud by the desktop companion.";
const opening = "Write the words to be spoken aloud.";

/** Only known scaffold sentences are generalized; custom wording remains verbatim. */
export function mergeTtsContent(telegram: string, desktop: string): string {
  const generalize = (text: string) => {
    for (const prefix of [telegramOpening, desktopOpening]) {
      if (text.startsWith(prefix)) return opening + text.slice(prefix.length);
    }
    return text;
  };
  const first = generalize(telegram);
  const second = generalize(desktop);
  if (!first) return second;
  if (!second || first.trim() === second.trim()) return first;
  // Distinct custom instructions must not disappear during the merge.
  return `${first}\n\n${second}`;
}

/** One-time data migration; the caller owns the migration transaction. */
export function mergeTtsPrompts(db: Database): void {
  const read = db.query<{ content: string; version: number }, [string]>(
    "SELECT content, version FROM core_prompts WHERE id = ?",
  );
  const telegram = read.get("channel.telegram-voice");
  const desktop = read.get("channel.desktop-voice");
  if (!telegram && !desktop) return;
  const content = mergeTtsContent(telegram?.content ?? "", desktop?.content ?? "");
  if (Buffer.byteLength(content, "utf8") > 256 * 1024)
    throw new Error("Combined TTS prompt exceeds the prompt size limit; review before migration.");
  const now = new Date().toISOString();
  const version = (telegram?.version ?? 0) + 1;
  db.query(`INSERT INTO core_prompts(id,title,purpose,content,version,updated_at)
    VALUES ('channel.telegram-voice','TTS Conversation Direction','Shared speech direction.',?,?,?)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content, version=excluded.version, updated_at=excluded.updated_at`).run(
    content,
    version,
    now,
  );
  db.query(
    "INSERT INTO core_prompt_revisions(prompt_id,version,content,created_at) VALUES ('channel.telegram-voice',?,?,?)",
  ).run(version, content, now);
  db.query("DELETE FROM core_prompt_revisions WHERE prompt_id = 'channel.desktop-voice'").run();
  db.query("DELETE FROM core_prompts WHERE id = 'channel.desktop-voice'").run();
  const row = db
    .query<{ ids: string }, []>("SELECT ids_json AS ids FROM core_prompt_order WHERE singleton = 1")
    .get();
  if (row) {
    const ids = JSON.parse(row.ids) as string[];
    const merged = [
      ...new Set(ids.map((id) => (id === "channel.desktop-voice" ? "channel.telegram-voice" : id))),
    ];
    if (JSON.stringify(merged) !== JSON.stringify(ids))
      db.query(
        "UPDATE core_prompt_order SET ids_json=?, version=version+1, updated_at=? WHERE singleton=1",
      ).run(JSON.stringify(merged), now);
  }
}
