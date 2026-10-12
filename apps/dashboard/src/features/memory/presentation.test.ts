import { describe, expect, test } from "bun:test";
import type { MemorySearchItem, MemorySettings } from "@valerie/core";
import {
  applyRecallPreset,
  humanToolName,
  memoryDraftIssues,
  memoryLabel,
  readableMemorySnippet,
  recallPresetId,
  recordCanBeEdited,
} from "./presentation";

const balanced: MemorySettings = {
  version: 7,
  coreTokens: 1_500,
  retrievedTokens: 2_000,
  topicTokens: 750,
};

describe("memory presentation", () => {
  test("editor limits account for multibyte text before a save is submitted", () => {
    expect(
      memoryDraftIssues({
        title: "🐸".repeat(50),
        body: "池".repeat(5000),
        thoughts: "A brief thought.",
      }),
    ).toMatchObject({ thoughts: "" });
    expect(
      memoryDraftIssues({ title: "🐸".repeat(50), body: "池".repeat(5000), thoughts: "" }).title,
    ).not.toBe("");
    expect(
      memoryDraftIssues({ title: "Frogs", body: "池".repeat(5000), thoughts: "" }).body,
    ).not.toBe("");
    expect(
      memoryDraftIssues({ title: "Frogs", body: "A".repeat(5000), thoughts: "A brief thought." }),
    ).toEqual({ title: "", body: "", thoughts: "" });
  });
  test("friendly recall presets preserve the saved settings version", () => {
    expect(recallPresetId(balanced)).toBe("balanced");
    expect(applyRecallPreset(balanced, "focused")).toEqual({
      version: 7,
      coreTokens: 1_000,
      retrievedTokens: 1_200,
      topicTokens: 400,
    });
    expect(recallPresetId({ ...balanced, retrievedTokens: 2_001 })).toBe("custom");
  });

  test("memory and tool labels use owner-facing language", () => {
    const item = { tier: "core", state: "active", historical: false } as MemorySearchItem;
    expect(memoryLabel(item)).toBe("Core");
    expect(memoryLabel({ ...item, tier: "short" })).toBe("Short-term");
    expect(memoryLabel({ ...item, tier: "long" })).toBe("Long-term · Obsidian");
    expect(memoryLabel({ ...item, state: "archived" })).toBe("Core · Archived");
    expect(humanToolName("conversation_search")).toBe("Searched older conversations");
  });

  test("only the latest saved-memory revision is editable", () => {
    const record = { source: "records", version: 3 } as Parameters<typeof recordCanBeEdited>[0];
    expect(recordCanBeEdited(record, 3)).toBe(true);
    expect(recordCanBeEdited(record, 4)).toBe(false);
    expect(recordCanBeEdited({ ...record, source: "vault" }, 3)).toBe(false);
  });

  test("note previews hide Markdown plumbing while detail text remains untouched", () => {
    expect(
      readableMemorySnippet(
        '# Topic - [ ] Draft [[Notes/Project|Project plan]] <span style="color:red">today</span> https://example.test',
      ),
    ).toBe("Topic Draft Project plan today External link");
    expect(readableMemorySnippet("***")).toBe("Open to read this memory.");
  });
});
