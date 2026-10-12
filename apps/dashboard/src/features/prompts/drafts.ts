import { type Draft, draftFromPrompt, type Prompt } from "./types";

/** Refresh saved versions without losing text still owned by the open editor tab. */
export function reconcileDrafts(
  prompts: Prompt[],
  current: Record<string, Draft>,
): Record<string, Draft> {
  const availableIds = new Set(prompts.map((prompt) => prompt.id));
  return Object.fromEntries([
    ...prompts.map((prompt) => {
      const existing = current[prompt.id];
      return [
        prompt.id,
        existing && existing.content !== existing.baseContent ? existing : draftFromPrompt(prompt),
      ];
    }),
    ...Object.entries(current).filter(
      ([id, draft]) => !availableIds.has(id) && draft.content !== draft.baseContent,
    ),
  ]);
}
