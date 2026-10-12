import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir } from "node:fs/promises";
import { basename, isAbsolute, sep } from "node:path";

export type VaultIngestNote = {
  path: string;
  title: string;
  body: string;
  sourceHash: string;
  modifiedAt: string;
  historical: boolean;
};

export type VaultScan = {
  notes: VaultIngestNote[];
  scannedAt: string;
  complete: boolean;
  unavailablePaths: string[];
  unavailablePrefixes: string[];
  status: "ready" | "partial" | "unavailable";
  reason?: "limit" | "io" | "changed" | "missing";
};

export type VaultScanLimits = {
  maxNotes: number;
  maxNoteBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxDepth: number;
};

export const VAULT_SCAN_LIMITS: Readonly<VaultScanLimits> = Object.freeze({
  maxNotes: 2_000,
  maxNoteBytes: 128 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxEntries: 20_000,
  maxDepth: 16,
});

const readRoots = ["Inbox", "Notes", "Journal", "Topics", "Valerie/Memories", "Archive"];
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Directory = {
  handle: FileHandle;
  stat: BigIntStats;
  parent?: Directory;
  name?: string;
};

function childPath(directory: Directory, name?: string): string {
  // Linux descriptors pin every directory. A rename or symlink substitution cannot
  // redirect an open into a different ancestor between checking and reading it.
  return `/proc/self/fd/${directory.handle.fd}${name ? `/${name}` : ""}`;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function unchanged(directory: Directory): Promise<boolean> {
  try {
    if (!directory.parent) return true;
    const current = await lstat(childPath(directory.parent, directory.name), { bigint: true });
    return (
      current.isDirectory() &&
      sameIdentity(current, directory.stat) &&
      (await unchanged(directory.parent))
    );
  } catch {
    return false;
  }
}

async function openDirectory(parent: Directory, name: string): Promise<Directory> {
  const handle = await open(childPath(parent, name), directoryFlags);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) throw new Error("Not a directory");
    return { handle, stat, parent, name };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function excluded(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("~") ||
    name.endsWith("~") ||
    name.toLowerCase() === "private" ||
    /(?:^|[._ ()-])(?:backup|backups|bak|conflict|conflicted|tmp)(?:$|[._ ()-])/i.test(name)
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function titleFor(path: string, body: string): string {
  const withoutFrontmatter = body.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  return (withoutFrontmatter.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(path, ".md")).slice(
    0,
    300,
  );
}

/** Read approved Markdown without following links or writing to the vault.
 * `complete` allows absence reconciliation. Partial scans preserve unseen sources,
 * while explicit unavailable paths/prefixes stop current recall of unsafe sources.
 * The caller owns the startup/periodic schedule and serializes reconciliation.
 */
export async function scanVault(
  root: string,
  overrides: Partial<VaultScanLimits> = {},
): Promise<VaultScan> {
  const limits = { ...VAULT_SCAN_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof VaultScanLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > VAULT_SCAN_LIMITS[key]
    )
      throw new Error("Vault scan limits must be positive integers within the hard limits.");
  }
  const scan: VaultScan = {
    notes: [],
    scannedAt: new Date().toISOString(),
    complete: true,
    unavailablePaths: [],
    unavailablePrefixes: [],
    status: "ready",
  };
  let entries = 0;
  let totalBytes = 0;
  let budgetExceeded = false;
  const ancestors: Directory[] = [];
  const markPartial = (reason: NonNullable<VaultScan["reason"]>) => {
    scan.complete = false;
    scan.status = "partial";
    scan.reason ??= reason;
  };
  const unavailable = (path: string, directory = false) => {
    (directory ? scan.unavailablePrefixes : scan.unavailablePaths).push(path);
  };
  const limitReached = () => {
    budgetExceeded = true;
    markPartial("limit");
  };

  const readNote = async (directory: Directory, name: string, path: string) => {
    let handle: FileHandle | undefined;
    try {
      handle = await open(childPath(directory, name), fileFlags);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limits.maxNoteBytes)) {
        unavailable(path);
        return;
      }
      if (
        scan.notes.length >= limits.maxNotes ||
        totalBytes + Number(before.size) > limits.maxTotalBytes
      ) {
        limitReached();
        return;
      }
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        const result = await handle.read(bytes, length, bytes.byteLength - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(childPath(directory, name), { bigint: true });
      if (
        length !== Number(before.size) ||
        !sameIdentity(before, after) ||
        !sameIdentity(after, current) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        !(await unchanged(directory))
      ) {
        unavailable(path);
        markPartial("changed");
        return;
      }
      const content = bytes.subarray(0, length);
      const body = decoder.decode(content);
      if (body.includes("\0")) {
        unavailable(path);
        return;
      }
      scan.notes.push({
        path,
        title: titleFor(path, body),
        body,
        sourceHash: createHash("sha256").update(content).digest("hex"),
        modifiedAt: new Date(Number(after.mtimeMs)).toISOString(),
        historical: path.startsWith("Archive/"),
      });
      totalBytes += length;
    } catch {
      unavailable(path);
      markPartial("io");
    } finally {
      await handle?.close();
    }
  };

  const visit = async (directory: Directory, path: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      // This is a permanent access boundary, unlike an aggregate scan budget.
      unavailable(path, true);
      return;
    }
    try {
      const listing = await opendir(childPath(directory));
      for await (const entry of listing) {
        if (++entries > limits.maxEntries) {
          limitReached();
          break;
        }
        const relative = `${path}/${entry.name}`;
        if (excluded(entry.name) || entry.isSymbolicLink()) {
          unavailable(relative, true);
          continue;
        }
        if (entry.isDirectory()) {
          unavailable(relative);
          let child: Directory | undefined;
          try {
            child = await openDirectory(directory, entry.name);
            await visit(child, relative, depth + 1);
          } catch {
            unavailable(relative, true);
            markPartial("io");
          } finally {
            await child?.handle.close();
          }
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          await readNote(directory, entry.name, relative);
        } else {
          unavailable(relative);
        }
        if (budgetExceeded) break;
      }
      if (!(await unchanged(directory))) {
        scan.notes = scan.notes.filter((note) => !note.path.startsWith(`${path}/`));
        unavailable(path, true);
        markPartial("changed");
      }
    } catch {
      unavailable(path, true);
      markPartial("io");
    }
  };

  try {
    if (process.platform !== "linux" || !isAbsolute(root))
      throw new Error("Unsupported vault root");
    const parts = root.split(sep).filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) throw new Error("Invalid vault root");
    const handle = await open("/", directoryFlags);
    let directory: Directory = { handle, stat: await handle.stat({ bigint: true }) };
    ancestors.push(directory);
    for (const part of parts) {
      directory = await openDirectory(directory, part);
      ancestors.push(directory);
    }
    for (const allowedRoot of readRoots) {
      const opened: Directory[] = [];
      try {
        let current = directory;
        for (const part of allowedRoot.split("/")) {
          current = await openDirectory(current, part);
          opened.push(current);
        }
        await visit(current, allowedRoot, 0);
      } catch (error) {
        unavailable(allowedRoot, true);
        if (errorCode(error) !== "ENOENT") markPartial("io");
      } finally {
        for (const current of opened.reverse()) await current.handle.close();
      }
      if (budgetExceeded) break;
    }
    if (!(await unchanged(directory))) throw new Error("Vault root changed");
  } catch (error) {
    scan.notes = [];
    scan.complete = false;
    scan.status = "unavailable";
    scan.reason = errorCode(error) === "ENOENT" ? "missing" : "io";
    scan.unavailablePrefixes = [""];
  } finally {
    for (const directory of ancestors.reverse()) await directory.handle.close();
  }
  scan.notes.sort((left, right) => left.path.localeCompare(right.path));
  scan.unavailablePaths = [...new Set(scan.unavailablePaths)].sort();
  scan.unavailablePrefixes = [...new Set(scan.unavailablePrefixes)].sort();
  return scan;
}
