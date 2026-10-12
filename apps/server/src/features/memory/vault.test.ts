import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanVault } from "./vault";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "valerie-vault-test-"));
  directories.push(root);
  return root;
}

async function note(
  root: string,
  path: string,
  body = "# Fictional note\nA fictional preference.",
) {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, body);
}

test("ordinary Markdown is indexed verbatim in approved roots, and Archive is historical", async () => {
  const root = await fixture();
  const body =
    "\uFEFF---\r\ntags: [fictional]\r\nunfamiliar: untouched\r\n---\r\n# Favorite shade\r\n\r\nLavender. [[Topics/Colors]]\r\n";
  await note(root, "Notes/Color.md", body);
  for (const path of [
    "Inbox/New.md",
    "Journal/Day.md",
    "Topics/Colors.md",
    "Valerie/Memories/Preference.md",
    "Archive/Old.md",
  ])
    await note(root, path);
  const scan = await scanVault(root);
  expect(scan.complete).toBe(true);
  expect(scan.status).toBe("ready");
  expect(scan.notes).toHaveLength(6);
  const imported = scan.notes.find((entry) => entry.path === "Notes/Color.md");
  expect(imported).toMatchObject({
    title: "Favorite shade",
    body,
    sourceHash: createHash("sha256").update(body).digest("hex"),
    historical: false,
  });
  expect(scan.notes.filter((entry) => entry.historical).map((entry) => entry.path)).toEqual([
    "Archive/Old.md",
  ]);
  expect(await readFile(join(root, "Notes/Color.md"), "utf8")).toBe(body);
});

test("policy, private, hidden, proposal, template, attachment and backup content stays excluded", async () => {
  const root = await fixture();
  await note(root, "Notes/Visible.md");
  for (const path of [
    "Home.md",
    "Valerie/Memory guidance.md",
    "Valerie/Access and ownership.md",
    "Valerie/Suggestions/Proposal.md",
    "Templates/Template.md",
    "Attachments/Attachment.md",
    "Private/Secret.md",
    "Notes/Private/Nested.md",
    "Notes/.obsidian/Secret.md",
    "Notes/.hidden.md",
    "Notes/backups/Old.md",
    "Notes/Copy.bak.md",
    "Notes/Copy (conflicted copy 2026).md",
    "Notes/Copy.sync-conflict-2026.md",
    "Notes/~Temporary.md",
  ])
    await note(root, path, "Never retrieve this fixture");
  expect((await scanVault(root)).notes.map((entry) => entry.path)).toEqual(["Notes/Visible.md"]);
});

test("file, directory, allow-root and vault-ancestor symlinks cannot bypass access", async () => {
  const root = await fixture();
  const outside = await fixture();
  await note(root, "Notes/Visible.md");
  await note(outside, "Secret.md", "Outside source");
  await symlink(join(outside, "Secret.md"), join(root, "Notes/File.md"));
  await symlink(outside, join(root, "Notes/Directory"));
  await symlink(outside, join(root, "Inbox"));
  await link(join(outside, "Secret.md"), join(root, "Notes/Hardlink.md"));
  const scan = await scanVault(root);
  expect(scan.notes.map((entry) => entry.path)).toEqual(["Notes/Visible.md"]);
  expect(scan.unavailablePrefixes).toContain("Inbox");
  expect(scan.unavailablePrefixes).toContain("Notes/File.md");
  expect(scan.unavailablePrefixes).toContain("Notes/Directory");
  expect(scan.unavailablePaths).toContain("Notes/Hardlink.md");
  const aliasParent = await fixture();
  await symlink(root, join(aliasParent, "alias"));
  const viaAlias = await scanVault(join(aliasParent, "alias"));
  expect(viaAlias.status).toBe("unavailable");
  expect(viaAlias.notes).toEqual([]);
  expect(viaAlias.unavailablePrefixes).toEqual([""]);
  await mkdir(join(root, "Nested"));
  expect((await scanVault(join(aliasParent, "alias/Nested"))).status).toBe("unavailable");
});

test("a directory replaced after opening cannot contribute bytes through the pinned descriptor", async () => {
  const root = await fixture();
  const outside = await fixture();
  await note(root, "Notes/Race.md", "Old allowed fixture");
  await note(outside, "Secret.md", "Outside fixture");
  const originalOpen = filesystem.open;
  let replaced = false;
  const openSpy = spyOn(filesystem, "open").mockImplementation(async (...args) => {
    if (!replaced && String(args[0]).endsWith("/Race.md")) {
      replaced = true;
      await rename(join(root, "Notes"), join(root, "Moved"));
      await symlink(outside, join(root, "Notes"));
    }
    return originalOpen(...args);
  });
  try {
    const scan = await scanVault(root);
    expect(replaced).toBe(true);
    expect(scan.notes).toEqual([]);
    expect(scan.complete).toBe(false);
    expect(scan.unavailablePrefixes).toContain("Notes");
  } finally {
    openSpy.mockRestore();
  }
});

test("a file replacement between opening and reading is rejected", async () => {
  const root = await fixture();
  await note(root, "Notes/Race.md", "Old allowed fixture");
  const originalOpen = filesystem.open;
  let replaced = false;
  const openSpy = spyOn(filesystem, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (!replaced && String(args[0]).endsWith("/Race.md")) {
      replaced = true;
      await rename(join(root, "Notes/Race.md"), join(root, "Notes/Old.txt"));
      await writeFile(join(root, "Notes/Race.md"), "Replacement fixture");
    }
    return handle;
  });
  try {
    const scan = await scanVault(root);
    expect(replaced).toBe(true);
    expect(scan.notes).toEqual([]);
    expect(scan.unavailablePaths).toContain("Notes/Race.md");
    expect(scan.complete).toBe(false);
  } finally {
    openSpy.mockRestore();
  }
});

test("complete scans reconcile deletions and renames; missing roots explicitly disable recall", async () => {
  const root = await fixture();
  await note(root, "Notes/Before.md");
  const first = await scanVault(root);
  await rename(join(root, "Notes/Before.md"), join(root, "Notes/After.md"));
  const renamed = await scanVault(root);
  expect(first.notes[0]?.sourceHash).toBe(renamed.notes[0]?.sourceHash);
  expect(renamed.complete).toBe(true);
  expect(renamed.notes.map((entry) => entry.path)).toEqual(["Notes/After.md"]);
  await rm(join(root, "Notes"), { recursive: true });
  const deleted = await scanVault(root);
  expect(deleted.complete).toBe(true);
  expect(deleted.notes).toEqual([]);
  expect(deleted.unavailablePrefixes).toContain("Notes");
  const missing = await scanVault(join(root, "missing"));
  expect(missing).toMatchObject({
    notes: [],
    complete: false,
    status: "unavailable",
    reason: "missing",
    unavailablePrefixes: [""],
  });
});

test("scan budgets preserve unseen sources and individually oversized or binary notes are unavailable", async () => {
  const root = await fixture();
  await note(root, "Notes/One.md", "one");
  await note(root, "Notes/Two.md", "two");
  const count = await scanVault(root, { maxNotes: 1 });
  expect(count).toMatchObject({ complete: false, status: "partial", reason: "limit" });
  expect(count.notes).toHaveLength(1);
  expect(count.unavailablePaths).toEqual([]);
  expect(count.unavailablePrefixes).not.toContain("Notes");
  const bytes = await scanVault(root, { maxTotalBytes: 4 });
  expect(bytes.notes).toHaveLength(1);
  expect(bytes.complete).toBe(false);
  const entries = await scanVault(root, { maxEntries: 1 });
  expect(entries.notes).toHaveLength(1);
  expect(entries.complete).toBe(false);
  await note(root, "Notes/Oversized.md", "x".repeat(101));
  await note(root, "Notes/Binary.md", "nul\0byte");
  await writeFile(join(root, "Notes/Invalid.md"), new Uint8Array([0xff]));
  const bounded = await scanVault(root, { maxNoteBytes: 100 });
  expect(bounded.notes).toHaveLength(2);
  expect(bounded.unavailablePaths).toEqual([
    "Notes/Binary.md",
    "Notes/Invalid.md",
    "Notes/Oversized.md",
  ]);
  await note(root, "Notes/Deep/Deeper/Hidden.md");
  expect((await scanVault(root, { maxDepth: 1 })).unavailablePrefixes).toContain(
    "Notes/Deep/Deeper",
  );
});

test("configuration cannot raise hard limits or normalize traversal into another root", async () => {
  const root = await fixture();
  await expect(scanVault(root, { maxNotes: 1_000_000 })).rejects.toThrow("hard limits");
  await expect(scanVault(root, { maxEntries: 0 })).rejects.toThrow("hard limits");
  expect((await scanVault(`${root}/../`)).status).toBe("unavailable");
  expect((await scanVault("relative/vault")).status).toBe("unavailable");
});
