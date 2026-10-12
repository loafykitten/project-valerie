/** Provider-neutral copies of the exact tool definitions offered with a captured turn. */
export interface ConversationToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ConversationToolCatalog {
  revision: string;
  schemas: ConversationToolSchema[];
}
export interface ConversationToolCapabilities {
  imageGeneration: boolean;
  memoryTools: boolean;
  dynamicTools: boolean;
  dailyTools: boolean;
  agreementTools: boolean;
  reminderTools: boolean;
}

export function validateConversationToolCatalog(
  value: ConversationToolCatalog,
): ConversationToolCatalog {
  if (
    !value ||
    typeof value !== "object" ||
    !/^[a-z0-9_.-]{1,80}$/i.test(value.revision) ||
    !Array.isArray(value.schemas) ||
    value.schemas.length > 16
  )
    throw new TypeError("Provide a bounded tool catalog revision.");
  const names = new Set<string>();
  for (const tool of value.schemas) {
    if (
      !tool ||
      !/^[a-z0-9_]{1,64}$/i.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 4096 ||
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters)
    )
      throw new TypeError("Tool catalog definitions are invalid.");
    names.add(tool.name);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 128 * 1024)
    throw new TypeError("Tool catalog exceeds its storage bound.");
  return JSON.parse(json) as ConversationToolCatalog;
}
