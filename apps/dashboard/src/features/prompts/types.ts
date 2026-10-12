export type Prompt = {
  id: string;
  title: string;
  purpose: string;
  content: string;
  version: number;
  updatedAt: string;
};

export type PromptCatalog = { prompts: Prompt[]; orderVersion: number };

export type Channel = "telegram-text" | "telegram-voice" | "desktop-voice";

export type PromptRevision = {
  promptId: string;
  version: number;
  content: string;
  createdAt: string;
};

export type PromptPreview = {
  channel: Channel;
  content: string;
  orderVersion: number;
  versions: Record<string, number>;
  postHistoryContent?: string;
  postHistoryPlacement?: "after-history";
  characterImportId?: string | null;
};

export type Draft = { content: string; baseContent: string; baseVersion: number };

export function draftFromPrompt(prompt: Prompt): Draft {
  return { content: prompt.content, baseContent: prompt.content, baseVersion: prompt.version };
}
