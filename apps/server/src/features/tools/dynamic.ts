import {
  createDynamicService,
  type DynamicNoteInput,
  type DynamicPermissions,
  type GrowthFocusSaveInput,
  type GrowthFocusState,
  type Store,
} from "@valerie/core";
import type { RegisteredTool, ToolContext } from "./registry";
import { versionSchema as integer, objectSchema as object, textSchema as string } from "./schema";

const sourceIds = {
  type: "array",
  minItems: 1,
  maxItems: 5,
  items: string(220),
  description:
    "Original owner message IDs (conversation:...), from the current evidence IDs or conversation_search/read in this chat. Include every message supporting the record. These establish evidence identity, not permission. Assistant claims and memory IDs are not owner evidence.",
};
const smallList = { type: "array", maxItems: 5, items: string(160) };
const defaults = {
  effect: "read" as const,
  allowedTurnKinds: ["user"] as const,
  timeoutMs: 1000,
  maxOutputBytes: 24000,
  outputSchema: { type: "object", additionalProperties: true },
};

/** Schema discovery stays available; each write intersects pinned and live owner permissions. */
export function createDynamicTools(
  store: Store,
  options: { permissions?: DynamicPermissions } = {},
): RegisteredTool[] {
  const dynamic = createDynamicService(store);
  const pinned = { ...(options.permissions ?? { manageFocus: false, logNotes: false }) };
  const contextFor = (context: ToolContext) => ({
    actor: "valerie" as const,
    turnId: context.turnId,
    operationKey: context.operationKey,
    permissions: pinned,
  });
  const receipt = (focus: ReturnType<typeof dynamic.saveFocus>) => ({
    id: focus.id,
    version: focus.version,
    state: focus.state,
    phase: focus.phase,
    reviewDue: focus.reviewDue,
    updatedAt: focus.updatedAt,
    sourceCount: focus.sources.length,
    stateSourceCount: focus.stateSources.length,
  });
  return [
    {
      ...defaults,
      name: "growth_focus_read",
      description:
        "Read the current Growth Focus or a saved focus ID, with bounded progress notes and live permissions. mode=history lists recent focus summaries. Paused and future focuses are not current practice obligations. A review date does not solve or end a focus. Notes marked superseded have a later correction; interpretations are not owner facts.",
      parameters: object({
        id: string(220),
        mode: { type: "string", enum: ["current", "history"] },
        cursor: string(220),
        limit: { type: "integer", minimum: 1, maximum: 4 },
      }),
      execute: (input, context) => {
        const settings = dynamic.getSettings();
        const permissions = {
          manageFocus: pinned.manageFocus && settings.allowValerieManageFocus,
          logNotes: pinned.logNotes && settings.allowValerieLogNotes,
        };
        if (input.mode === "history")
          return {
            permissions,
            items: dynamic
              .list({ limit: (input.limit as number | undefined) ?? 4, turnId: context.turnId })
              .map(({ id, version, title, state, phase, startDate, reviewDate }) => ({
                id,
                version,
                title,
                state,
                phase,
                startDate,
                reviewDate,
              })),
          };
        const focus = input.id
          ? dynamic.read(input.id as string, { turnId: context.turnId })
          : dynamic.current({ turnId: context.turnId });
        if (!focus) return { found: false, permissions };
        return {
          found: true,
          permissions,
          focus,
          notes: dynamic.notes(focus.id, {
            limit: (input.limit as number | undefined) ?? 2,
            cursor: input.cursor as string | undefined,
            turnId: context.turnId,
          }),
        };
      },
    },
    {
      ...defaults,
      effect: "local_write",
      name: "growth_focus_save",
      description:
        "Choose or revise the single Growth Focus only when owner delegation permits it. Ground it in discussed concerns; do not invent commitments. For a NEW focus, OMIT id and expectedVersion entirely; do not send null, zero or empty values. For an edit provide its ID/current expectedVersion from growth_focus_read. For a different focus archive the old one first. This saves focus context, not reminders or habit completions. Dates are calendar dates in America/Chicago; roughly four to eight weeks is a useful starting span, but review timing is adjustable.",
      parameters: object(
        {
          id: string(220),
          expectedVersion: integer,
          title: string(120),
          reason: {
            ...string(800),
            description:
              "Why this area matters to the owner; keep tool and permission logistics out of the reason.",
          },
          startDate: string(10),
          reviewDate: string(10),
          practices: smallList,
          indicators: smallList,
          sourceIds,
        },
        ["title", "reason", "startDate", "reviewDate", "practices", "indicators", "sourceIds"],
      ),
      execute: (input, context) =>
        receipt(dynamic.saveFocus(input as unknown as GrowthFocusSaveInput, contextFor(context))),
    },
    {
      ...defaults,
      effect: "local_write",
      name: "growth_focus_set_state",
      description:
        "Pause, resume, or archive the current Growth Focus within owner-granted management permission, using its current version and supporting owner messages. Archived history cannot be resumed or rewritten. Pausing stops practice pressure; passing the review date never archives automatically.",
      parameters: object(
        {
          id: string(220),
          expectedVersion: integer,
          state: { type: "string", enum: ["active", "paused", "archived"] },
          sourceIds,
        },
        ["id", "expectedVersion", "state", "sourceIds"],
      ),
      execute: (input, context) =>
        receipt(
          dynamic.setFocusState(
            input as unknown as {
              id: string;
              expectedVersion: number;
              state: GrowthFocusState;
              sourceIds: string[];
            },
            contextFor(context),
          ),
        ),
    },
    {
      ...defaults,
      effect: "local_write",
      name: "growth_focus_log_note",
      description:
        "Record a concise source-linked progress note only when note permission allows. Use this for reports, feelings, obstacles and adjustments about the current focus; use memory_save for general memories, without duplicating the same note in both. owner_report summarizes what the owner actually reported; valerie_interpretation is your tentative understanding, not an observed fact. Silence, plans, warm messages, and delivered reminders are not evidence of completed actions or failures. Use supersedesNoteId to correct a prior note, preserving its original evidence. Honest painful feelings are welcome disclosures, never automatically rule violations.",
      parameters: object(
        {
          focusId: string(220),
          expectedFocusVersion: integer,
          body: string(1200),
          kind: { type: "string", enum: ["owner_report", "valerie_interpretation"] },
          sourceIds,
          supersedesNoteId: string(220),
        },
        ["focusId", "expectedFocusVersion", "body", "kind", "sourceIds"],
      ),
      execute: (input, context) => {
        const note = dynamic.addNote(input as unknown as DynamicNoteInput, contextFor(context));
        return {
          id: note.id,
          focusId: note.focusId,
          kind: note.kind,
          createdAt: note.createdAt,
          supersedesNoteId: note.supersedesNoteId,
          sourceCount: note.sources.length,
        };
      },
    },
  ];
}
