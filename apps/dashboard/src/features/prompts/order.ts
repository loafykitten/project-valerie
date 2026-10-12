import type { Prompt } from "./types";

export const postHistoryId = "character.post-history";
export type DropPosition = "before" | "after";

/** Move one section while keeping after-history instructions in their final position. */
export function movePrompt(
  prompts: readonly Pick<Prompt, "id">[],
  movingId: string,
  targetId: string,
  position: DropPosition,
): string[] | null {
  const ids = prompts.map((prompt) => prompt.id);
  if (
    movingId === postHistoryId ||
    movingId === targetId ||
    !ids.includes(movingId) ||
    !ids.includes(targetId)
  )
    return null;

  const result = ids.filter((id) => id !== movingId);
  const targetIndex = result.indexOf(targetId);
  result.splice(
    targetIndex + (position === "after" && targetId !== postHistoryId ? 1 : 0),
    0,
    movingId,
  );
  return result.every((id, index) => id === ids[index]) ? null : result;
}
