import { type DynamicPermissions, DynamicValidationError, type Store } from "@valerie/core";
import { createDynamicTools } from "./dynamic";
import { type RegisteredTool, validateToolInput } from "./registry";

/** The new catalog groups writes; legacy snapshots retain their original three write names. */
export function createGroupedDynamicTools(
  store: Store,
  options: { permissions?: DynamicPermissions } = {},
): RegisteredTool[] {
  const legacy = createDynamicTools(store, options);
  const read = legacy.find((tool) => tool.name === "growth_focus_read");
  const actions = {
    save: legacy.find((tool) => tool.name === "growth_focus_save"),
    set_state: legacy.find((tool) => tool.name === "growth_focus_set_state"),
    log_note: legacy.find((tool) => tool.name === "growth_focus_log_note"),
  };
  if (!read || !actions.save || !actions.set_state || !actions.log_note)
    throw new Error("Growth Focus catalog is incomplete.");
  return [
    read,
    {
      name: "growth_focus_write",
      description:
        "Save, pause/resume/archive, or add a source-linked note to Growth Focus within the owner's pinned and live delegation. Choose action=save, set_state or log_note and provide only the matching payload object. Save creates or edits a focus; set_state changes its state; log_note records owner-reported progress or a labelled interpretation, never habit completion or a reminder. Read growth_focus_read for current IDs/versions. New focus: omit id and expectedVersion inside save. Dates and review timing come from actual owner direction; examples are not commitments. Honest painful disclosures are welcome, never automatic violations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["save", "set_state", "log_note"] },
          save: actions.save.parameters,
          set_state: actions.set_state.parameters,
          log_note: actions.log_note.parameters,
        },
        required: ["action"],
      },
      effect: "local_write",
      allowedTurnKinds: ["user"],
      timeoutMs: 1000,
      maxOutputBytes: 24000,
      argumentHelp:
        'Growth Focus writes use action plus one matching payload object. For action="set_state", supply set_state:{id,expectedVersion,state,sourceIds}; do not put these fields under save or at the top level. For action="save", put all focus fields under save. For action="log_note", put the note fields under log_note. Read growth_focus_read for current IDs and versions. sourceIds must be an array of original owner source-ID strings.',
      outputSchema: { type: "object", additionalProperties: true },
      execute: (input, context) => {
        const action = input.action;
        if (action !== "save" && action !== "set_state" && action !== "log_note")
          throw new DynamicValidationError(
            "action",
            "invalid_action",
            "Choose a supported Growth Focus write action.",
          );
        const tool = actions[action];
        if (
          !tool ||
          Object.keys(input).some((key) => key !== "action" && key !== action) ||
          !validateToolInput(input[action], tool.parameters)
        )
          throw new DynamicValidationError(
            action,
            "invalid_arguments",
            "Provide only the complete payload matching the selected Growth Focus action.",
          );
        return tool.execute(input[action] as Record<string, unknown>, context);
      },
    },
  ];
}
