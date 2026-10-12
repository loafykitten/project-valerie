import { describe, expect, test } from "bun:test";
import type { GrowthFocus } from "@valerie/core";
import {
  focusChanged,
  focusDate,
  focusDraft,
  focusDraftError,
  focusFields,
  focusStatus,
} from "./presentation";

const focus: GrowthFocus = {
  id: "fictional-focus",
  version: 3,
  title: "Make room for music",
  reason: "Enjoy learning without rushing.",
  startDate: "2026-09-15",
  reviewDate: "2026-10-27",
  practices: ["Play a song for fun"],
  indicators: ["Picking up the guitar feels inviting"],
  state: "active",
  phase: "active",
  reviewDue: false,
  sources: [],
  stateSources: [],
  authoredBy: "owner",
  createdAt: "2026-09-15T18:00:00.000Z",
  updatedAt: "2026-09-15T18:00:00.000Z",
};

describe("Growth Focus dashboard drafts", () => {
  test("new focus starts without an invented commitment or dates", () => {
    expect(focusFields(focusDraft(null))).toEqual({
      title: "",
      reason: "",
      startDate: "",
      reviewDate: "",
      practices: [],
      indicators: [],
    });
  });

  test("an open draft keeps its original revision and text after the saved focus changes", () => {
    const draft = focusDraft(focus);
    const saved = {
      ...focus,
      version: 4,
      title: "Make room for drawing",
      practices: ["Draw a small sketch"],
    };
    expect(draft.baseVersion).toBe(3);
    expect(draft.title).toBe("Make room for music");
    expect(draft.practices).toBe("Play a song for fun");
    expect(draft.baseVersion).not.toBe(saved.version);
    expect(focusChanged(draft, focusDraft(saved))).toBe(true);
  });

  test("blank lines and surrounding spaces do not create empty practices or false dirty state", () => {
    const base = focusDraft(focus);
    const draft = { ...base, title: ` ${base.title} `, practices: `\n ${base.practices} \n\n` };
    expect(focusFields(draft).practices).toEqual(focus.practices);
    expect(focusChanged(draft, base)).toBe(false);
  });

  test("Unicode text is checked against the server's byte bounds before save", () => {
    const draft = { ...focusDraft(focus), title: "🎵".repeat(31) };
    expect(draft.title.length).toBeLessThan(120);
    expect(focusDraftError(draft)).toBe("Please shorten the title before saving.");
  });

  test("early reviews and continued focus are allowed but a same-day review is not", () => {
    expect(focusDraftError({ ...focusDraft(focus), reviewDate: "2026-09-16" })).toBeNull();
    expect(focusDraftError({ ...focusDraft(focus), reviewDate: "2026-09-15" })).toContain(
      "after the start",
    );
  });

  test("pause and archive take precedence over an old review-due flag", () => {
    expect(focusStatus({ ...focus, state: "paused", phase: "paused", reviewDue: true }).label).toBe(
      "Paused",
    );
    expect(
      focusStatus({ ...focus, state: "archived", phase: "archived", reviewDue: true }).label,
    ).toBe("Archived");
  });

  test("review-due state invites review and does not present completion", () => {
    expect(focusStatus({ ...focus, reviewDue: true }).label).toBe("Ready to review");
  });

  test("calendar dates retain their day across daylight-saving boundaries", () => {
    expect(focusDate("2026-11-01")).toContain("Nov 1");
    expect(focusDate("2026-03-08")).toContain("Mar 8");
  });
});
