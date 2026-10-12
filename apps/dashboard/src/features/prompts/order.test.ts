import { expect, test } from "bun:test";
import { movePrompt, postHistoryId } from "./order";

const prompts = ["identity", "personality", "voice", postHistoryId].map((id) => ({ id }));

test("moving in either direction uses the requested side of the target", () => {
  expect(movePrompt(prompts, "identity", "voice", "after")).toEqual([
    "personality",
    "voice",
    "identity",
    postHistoryId,
  ]);
  expect(movePrompt(prompts, "voice", "identity", "before")).toEqual([
    "voice",
    "identity",
    "personality",
    postHistoryId,
  ]);
  expect(movePrompt(prompts, "identity", "voice", "before")).toEqual([
    "personality",
    "identity",
    "voice",
    postHistoryId,
  ]);
  expect(prompts.map((prompt) => prompt.id)).toEqual([
    "identity",
    "personality",
    "voice",
    postHistoryId,
  ]);
});

test("dropping onto the pinned section inserts immediately before it", () => {
  for (const position of ["before", "after"] as const) {
    expect(movePrompt(prompts, "identity", postHistoryId, position)).toEqual([
      "personality",
      "voice",
      "identity",
      postHistoryId,
    ]);
    expect(movePrompt(prompts, postHistoryId, "identity", position)).toBeNull();
  }
});

test("invalid, cancelled and unchanged moves do not submit a save", () => {
  expect(movePrompt(prompts, "identity", "identity", "after")).toBeNull();
  expect(movePrompt(prompts, "identity", "personality", "before")).toBeNull();
  expect(movePrompt(prompts, "voice", postHistoryId, "after")).toBeNull();
  expect(movePrompt(prompts, "unknown", "identity", "before")).toBeNull();
  expect(movePrompt(prompts, "identity", "unknown", "before")).toBeNull();
});
