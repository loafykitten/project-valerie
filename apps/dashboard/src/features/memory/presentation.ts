import type { MemoryRecord, MemorySearchItem, MemorySettings } from "@valerie/core";

export type MemorySourceFilter = "all" | "records" | "vault" | "conversations";

export function memoryDraftIssues(draft: { title: string; body: string; thoughts: string }) {
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  return {
    title: bytes(draft.title) > 160 ? "This label is too long. Shorten it before saving." : "",
    body:
      bytes(draft.body) > 12000
        ? "This summary is too long. Keep the essential details before saving."
        : "",
    thoughts:
      bytes(draft.thoughts) > 4000
        ? "These thoughts are too long. Shorten them before saving."
        : "",
  };
}

export const recallPresets = [
  {
    id: "focused",
    title: "Focused",
    description: "Keeps replies lean and brings in only the closest supporting details.",
    coreTokens: 1_000,
    retrievedTokens: 1_200,
    topicTokens: 400,
  },
  {
    id: "balanced",
    title: "Balanced",
    description: "A comfortable amount of personal context for everyday conversation.",
    coreTokens: 1_500,
    retrievedTokens: 2_000,
    topicTokens: 750,
  },
  {
    id: "roomy",
    title: "Roomy",
    description: "Brings in more related notes for complex projects and deeper topics.",
    coreTokens: 2_500,
    retrievedTokens: 4_000,
    topicTokens: 1_500,
  },
] as const;

export type RecallPresetId = (typeof recallPresets)[number]["id"] | "custom";

export function recallPresetId(settings: MemorySettings): RecallPresetId {
  return (
    recallPresets.find(
      (preset) =>
        preset.coreTokens === settings.coreTokens &&
        preset.retrievedTokens === settings.retrievedTokens &&
        preset.topicTokens === settings.topicTokens,
    )?.id ?? "custom"
  );
}

export function applyRecallPreset(settings: MemorySettings, id: Exclude<RecallPresetId, "custom">) {
  const preset = recallPresets.find((candidate) => candidate.id === id);
  if (!preset) return settings;
  return {
    version: settings.version,
    coreTokens: preset.coreTokens,
    retrievedTokens: preset.retrievedTokens,
    topicTokens: preset.topicTokens,
  };
}

export function memoryLabel(memory: Pick<MemorySearchItem, "tier" | "state" | "historical">) {
  const tier =
    memory.tier === "core"
      ? "Core"
      : memory.tier === "short"
        ? "Short-term"
        : "Long-term · Obsidian";
  return memory.state !== "active" || memory.historical ? `${tier} · Archived` : tier;
}

export function memoryDescription(memory: Pick<MemorySearchItem, "sourcePath" | "updatedAt">) {
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(memory.updatedAt));
  return memory.sourcePath ? `Obsidian note · Updated ${date}` : `Saved ${date}`;
}

export function readableMemorySnippet(value: string) {
  const readable = value
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/https?:\/\/\S+/g, "External link")
    .replace(/(^|\s)[#>*_`~-]+(?=\s|$)/g, " ")
    .replace(/\[(?: |x|X)\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return readable || "Open to read this memory.";
}

export function humanToolName(name: string) {
  const names: Record<string, string> = {
    activity_search: "Checked recent activity",
    conversation_search: "Searched older conversations",
    conversation_read: "Read an earlier message",
    generate_image: "Started a picture",
    memory_read: "Opened a memory",
    memory_related: "Followed related memories",
    memory_save: "Saved a memory",
    memory_search: "Searched memory",
    topics_list: "Looked through topics",
  };
  return names[name] ?? "Used a memory tool";
}

export function recordCanBeEdited(record: MemoryRecord, latestVersion: number) {
  return record.source === "records" && record.version === latestVersion;
}
