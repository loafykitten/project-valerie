import { expect, test } from "bun:test";
import { reconcileDrafts } from "./drafts";
import type { Draft, Prompt } from "./types";

test("reload preserves unsaved removed sections and stale drafts while refreshing saved text", () => {
  const current: Record<string, Draft> = {
    "character.first-message": {
      content: "Unsaved greeting edit",
      baseContent: "Old greeting",
      baseVersion: 2,
    },
    "character.creator-notes": {
      content: "Saved notes",
      baseContent: "Saved notes",
      baseVersion: 1,
    },
    personality: { content: "My unsaved wording", baseContent: "Previous wording", baseVersion: 2 },
    voice: { content: "Saved voice", baseContent: "Saved voice", baseVersion: 1 },
  };
  const original = structuredClone(current);
  const prompts: Prompt[] = ["personality", "voice"].map((id) => ({
    id,
    title: id,
    purpose: "Conversation guidance",
    content: "New server version",
    version: 3,
    updatedAt: "2026-09-12T00:00:00Z",
  }));
  const next = reconcileDrafts(prompts, current);
  expect(next["character.first-message"]).toEqual(current["character.first-message"]);
  expect(next["character.creator-notes"]).toBeUndefined();
  expect(next.personality).toEqual(current.personality);
  expect(next.voice).toEqual({
    content: "New server version",
    baseContent: "New server version",
    baseVersion: 3,
  });
  expect(reconcileDrafts(prompts, next)).toEqual(next);
  expect(current).toEqual(original);
});

test("a saved order refreshes clean sections and preserves the base version of dirty drafts", () => {
  const saved = (id: string, version: number): Prompt => ({
    id,
    title: id,
    purpose: "Conversation guidance",
    content: `Saved ${id} ${version}`,
    version,
    updatedAt: "2026-09-13T00:00:00Z",
  });
  const current: Record<string, Draft> = {
    identity: { content: "My current typing", baseContent: "Saved identity 1", baseVersion: 1 },
    voice: { content: "Saved voice 1", baseContent: "Saved voice 1", baseVersion: 1 },
  };
  const next = reconcileDrafts([saved("voice", 2), saved("identity", 3)], current);
  expect(next.identity).toEqual(current.identity);
  expect(next.voice).toEqual({
    content: "Saved voice 2",
    baseContent: "Saved voice 2",
    baseVersion: 2,
  });
});
