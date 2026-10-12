import {
  type ConversationSnapshot,
  type ConversationToolCapabilities,
  type ConversationToolCatalog,
  type ConversationToolSchema,
  type Store,
  validateConversationToolCatalog,
} from "@valerie/core";
import { createAgreementTools } from "./agreements";
import legacy016 from "./catalog/legacy-016.json";
import { createDailyTools } from "./daily";
import { createDynamicTools } from "./dynamic";
import { createGroupedDynamicTools } from "./grouped-dynamic";
import { imageTool } from "./image-schema";
import { memoryToolDefinitions } from "./memory";
import type { RegisteredTool } from "./registry";
import { createReminderTools } from "./reminders";

export const CURRENT_TOOL_CATALOG = "agreements-018-v4";
const ATOMIC_PRACTICE_CATALOG = "agreements-018-v3";
const FLAT_REMINDER_CATALOG = "agreements-018-v2";
const NESTED_REMINDER_CATALOG = "agreements-018-v1";
const schema = ({
  name,
  description,
  parameters,
}: ConversationToolSchema): ConversationToolSchema => ({ name, description, parameters });

/** Called inside core's snapshot transaction; it constructs schemas without executing tools. */
export function captureToolCatalog(
  store: Store,
  flags: ConversationToolCapabilities,
): ConversationToolCatalog {
  const definitions: ConversationToolSchema[] = [
    ...(flags.imageGeneration ? [imageTool] : []),
    ...(flags.memoryTools ? memoryToolDefinitions(store) : []),
    ...(flags.dynamicTools ? createGroupedDynamicTools(store) : []),
    ...(flags.dailyTools
      ? createDailyTools(store, { extended: true, habitPractice: flags.agreementTools })
      : flags.agreementTools || flags.reminderTools
        ? createDailyTools(store, { extended: true }).filter((tool) => tool.name === "daily_read")
        : []),
    ...(flags.agreementTools ? createAgreementTools(store) : []),
    ...(flags.reminderTools ? createReminderTools(store, { structuredTime: true }) : []),
  ];
  return validateConversationToolCatalog({
    revision: CURRENT_TOOL_CATALOG,
    schemas: definitions.map(schema),
  });
}

/** Pre-catalog turns keep the deployed legacy contracts and names, never grouped capabilities. */
function legacyCatalog(snapshot: ConversationSnapshot): ConversationToolCatalog {
  const names = new Set<string>([
    ...(snapshot.imageGenerationEnabled ? ["generate_image"] : []),
    ...(snapshot.memoryToolsEnabled
      ? [
          "memory_search",
          "memory_read",
          "memory_related",
          "topics_list",
          "conversation_search",
          "conversation_read",
          "activity_search",
          "memory_save",
        ]
      : []),
    ...(snapshot.dynamicToolsEnabled
      ? [
          "growth_focus_read",
          "growth_focus_save",
          "growth_focus_set_state",
          "growth_focus_log_note",
        ]
      : []),
    ...(snapshot.dailyToolsEnabled ? ["daily_read", "daily_waking", "daily_progress"] : []),
  ]);
  return validateConversationToolCatalog({
    revision: "legacy-016",
    schemas: legacy016.schemas.filter((tool) => names.has(tool.name)),
  });
}

export function bindConversationTools(
  store: Store,
  snapshot: ConversationSnapshot,
  options: { now?: () => Date; image?: RegisteredTool } = {},
): { catalog: ConversationToolCatalog; tools: RegisteredTool[] } {
  const catalog = snapshot.toolCatalog
    ? validateConversationToolCatalog(snapshot.toolCatalog)
    : legacyCatalog(snapshot);
  if (
    ![
      CURRENT_TOOL_CATALOG,
      ATOMIC_PRACTICE_CATALOG,
      FLAT_REMINDER_CATALOG,
      NESTED_REMINDER_CATALOG,
      "legacy-016",
    ].includes(catalog.revision)
  )
    throw new TypeError("This pinned tool catalog is not supported by this runtime.");
  const modern = catalog.revision !== "legacy-016";
  const available: RegisteredTool[] = [
    ...(snapshot.memoryToolsEnabled && snapshot.memory ? memoryToolDefinitions(store) : []),
    ...(snapshot.dynamicToolsEnabled && snapshot.dynamic
      ? modern
        ? createGroupedDynamicTools(store, { permissions: snapshot.dynamic?.permissions })
        : createDynamicTools(store, { permissions: snapshot.dynamic?.permissions })
      : []),
    ...createDailyTools(store, {
      permissions: snapshot.daily?.permissions,
      now: options.now,
      currentDay: snapshot.daily?.currentDay,
      extended: modern,
      habitPractice:
        [CURRENT_TOOL_CATALOG, ATOMIC_PRACTICE_CATALOG].includes(catalog.revision) &&
        snapshot.agreementToolsEnabled === true,
      agreementPermissions: snapshot.agreements?.permissions,
      reminderPermissions: snapshot.reminders?.permissions,
      offeredToolNames: catalog.schemas.map((tool) => tool.name),
    }).filter((tool) =>
      tool.name === "daily_read"
        ? snapshot.dailyToolsEnabled ||
          (modern && (snapshot.agreementToolsEnabled || snapshot.reminderToolsEnabled))
        : snapshot.dailyToolsEnabled && snapshot.daily,
    ),
    ...(modern && snapshot.agreementToolsEnabled && snapshot.agreements
      ? createAgreementTools(store, {
          permissions: snapshot.agreements?.permissions,
          now: options.now,
        })
      : []),
    ...(modern && snapshot.reminderToolsEnabled && snapshot.reminders
      ? createReminderTools(store, {
          permissions: snapshot.reminders?.permissions,
          now: options.now,
          legacyNested: catalog.revision === NESTED_REMINDER_CATALOG,
          structuredTime: catalog.revision === CURRENT_TOOL_CATALOG,
        })
      : []),
    ...(options.image ? [options.image] : []),
  ];
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  const tools = catalog.schemas.map((definition) => {
    const tool = byName.get(definition.name);
    if (!tool)
      return {
        ...definition,
        effect: "read" as const,
        allowedTurnKinds: [],
        timeoutMs: 1000,
        maxOutputBytes: 256,
        outputSchema: { type: "object", additionalProperties: true },
        execute: () => ({}),
      };
    return { ...tool, ...structuredClone(definition) };
  });
  return { catalog, tools };
}
