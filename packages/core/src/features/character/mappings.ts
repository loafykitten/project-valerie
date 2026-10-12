/** Stable import destinations. Authored content is never split or rewritten. */
export const characterMappings = [
  {
    sourceField: "description",
    promptId: "character.description",
    title: "Character Description",
    purpose:
      "Valerie's background, appearance, and manner. Shared by text and voice conversations.",
    placement: "system",
  },
  {
    sourceField: "personality",
    promptId: "character.personality",
    title: "Character Personality",
    purpose:
      "Core traits that guide Valerie's attitude, reactions, and choices across conversations.",
    placement: "system",
  },
  {
    sourceField: "scenario",
    promptId: "character.scenario",
    title: "Scenario",
    purpose: "The setting and shared circumstances that give conversations their context.",
    placement: "system",
  },
  {
    sourceField: "mes_example",
    promptId: "character.examples",
    title: "Dialogue Examples",
    purpose:
      "Sample exchanges that demonstrate Valerie's tone, wording, and pacing for Telegram text replies.",
    placement: "telegram-text-example",
  },
  {
    sourceField: "system_prompt",
    promptId: "character.system-prompt",
    title: "Character Instructions",
    purpose:
      "Rules for Valerie's behavior: how she responds, handles requests, and respects boundaries. Speech style belongs in Voice And Speech Patterns.",
    placement: "system",
  },
  {
    sourceField: "post_history_instructions",
    promptId: "character.post-history",
    title: "Post-History Instructions",
    purpose:
      "Final guidance for Valerie's next reply, sent after the conversation history. This section stays last.",
    placement: "after-history",
  },
] as const;

/** Removed from the editable catalog at Ember's request; originals remain in the source archive. */
export const retiredCharacterPromptIds = [
  "character.first-message",
  "character.creator-notes",
] as const;

// Historical immutable import reports can still describe the retired reference fields.
export type CharacterSourceField =
  | (typeof characterMappings)[number]["sourceField"]
  | "first_mes"
  | "creator_notes";
export type CharacterPromptPlacement =
  | (typeof characterMappings)[number]["placement"]
  | "stored-only";
