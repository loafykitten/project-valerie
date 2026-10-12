import { expect, test } from "bun:test";
import { createActivityService, openStore } from "../src";

test("recent activity search is literal and outstanding work survives the seven-day window", () => {
  const store = openStore(":memory:");
  try {
    const activity = createActivityService(store);
    const pending = activity.append({
      kind: "system.check",
      summary: "Waiting for a log review",
      status: "pending",
    });
    store.db
      .query("UPDATE core_activity SET created_at = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", pending.id);
    const recent = activity.append({
      kind: "system.check",
      summary: "Docker log usage 25%",
      metadata: { source: "docker" },
    });
    activity.append({ kind: "prompt.updated", summary: "Saved prompt" });
    expect(activity.list()).toHaveLength(2);
    expect(activity.list({ query: "DOCKER" }).map((entry) => entry.id)).toEqual([recent.id]);
    expect(activity.list({ query: "%" }).map((entry) => entry.id)).toEqual([recent.id]);
    expect(activity.outstanding().map((entry) => entry.id)).toEqual([pending.id]);
    activity.updateStatus(pending.id, "succeeded");
    expect(activity.outstanding()).toHaveLength(0);
    expect(JSON.parse(activity.get(recent.id)?.metadataJson ?? "null")).toEqual({
      source: "docker",
    });
  } finally {
    store.close();
  }
});
