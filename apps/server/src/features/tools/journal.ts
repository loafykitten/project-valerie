import { createActivityService, type Store } from "@valerie/core";
import type { TextCompletion } from "@valerie/inference";
import type { ToolEffect, ToolOutcome } from "./registry";

export function createToolJournal(store: Store, turnId: string) {
  const activity = createActivityService(store);
  return {
    readRound(round: number): TextCompletion | null {
      const row = store.db
        .query<{ completion_json: string }, [string, number]>(
          "SELECT completion_json FROM core_tool_rounds WHERE turn_id=? AND round=?",
        )
        .get(turnId, round);
      return row ? JSON.parse(row.completion_json) : null;
    },
    saveRound(round: number, completion: TextCompletion): void {
      store.db
        .query(
          "INSERT INTO core_tool_rounds(turn_id,round,completion_json,created_at) VALUES (?,?,?,?)",
        )
        .run(turnId, round, JSON.stringify(completion), new Date().toISOString());
    },
    readOutcome(round: number, index: number): ToolOutcome | null {
      const row = store.db
        .query<{ outcome_json: string }, [string, number, number]>(
          "SELECT outcome_json FROM core_tool_outcomes WHERE turn_id=? AND round=? AND call_index=?",
        )
        .get(turnId, round, index);
      return row ? JSON.parse(row.outcome_json) : null;
    },
    saveOutcome(
      round: number,
      index: number,
      name: string,
      outcome: ToolOutcome,
      effect: ToolEffect | "rejected",
    ): void {
      store.db
        .transaction(() => {
          store.db
            .query(
              "INSERT INTO core_tool_outcomes(turn_id,round,call_index,tool_name,effect,outcome_json,created_at) VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              turnId,
              round,
              index,
              name,
              effect,
              JSON.stringify(outcome),
              new Date().toISOString(),
            );
          activity.append({
            kind: `tool.${name}`,
            summary:
              outcome.status !== "succeeded"
                ? `The ${name} request did not complete.`
                : name === "generate_image"
                  ? "Accepted an image request; delivery remains pending."
                  : name === "memory_save"
                    ? "Saved a supported short-term memory."
                    : `Completed ${name}.`,
            status: outcome.status === "succeeded" ? "succeeded" : "failed",
            metadata: { turnId, round, callIndex: index, effect, code: outcome.code ?? null },
          });
        })
        .immediate();
    },
  };
}
