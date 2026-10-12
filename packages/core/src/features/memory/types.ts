export type MemoryTier = "core" | "short" | "long";
export type MemoryKind = "preference" | "fact" | "experience" | "knowledge" | "procedure";
export interface MemoryProvenance {
  sourceType: "owner" | "conversation" | "vault";
  sourceId: string;
  observedAt: string;
  quote?: string;
}
export interface MemoryRecord {
  id: string;
  source: "records" | "vault";
  tier: MemoryTier;
  kind: MemoryKind;
  title: string;
  body: string;
  thoughts?: string;
  authoredBy?: "owner" | "valerie";
  version: number;
  state: "active" | "archived" | "superseded";
  available: boolean;
  historical: boolean;
  sourcePath?: string;
  sourceHash?: string;
  topicIds: string[];
  provenance: MemoryProvenance[];
  provenanceTruncated?: boolean;
  evidenceType: "explicit" | "observed" | "inferred";
  importance: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersedesId?: string;
}
export interface MemorySaveInput {
  id?: string;
  expectedVersion?: number;
  tier: "core" | "short";
  kind: MemoryKind;
  title: string;
  body: string;
  thoughts?: string;
  authoredBy?: "owner" | "valerie";
  evidenceType?: MemoryRecord["evidenceType"];
  provenance?: MemoryProvenance[];
  provenanceTruncated?: boolean;
  topicIds?: string[];
  importance?: number;
  expiresAt?: string;
  supersedesId?: string;
  supersedesVersion?: number;
}
export interface MemorySettings {
  version: number;
  coreTokens: number;
  retrievedTokens: number;
  topicTokens: number;
}
export interface MemorySearchInput {
  query: string;
  source?: "all" | "records" | "vault";
  tier?: MemoryTier;
  includeArchive?: boolean;
  limit?: number;
  cursor?: string;
  folder?: string;
  directChildren?: boolean;
}
export interface NoteFolder {
  path: string;
  name: string;
  noteCount: number;
}
export interface NoteLibraryPage extends MemoryPage<MemorySearchItem> {
  folder: string;
  folders: NoteFolder[];
  noteCount: number;
}
export interface MemorySearchItem extends Omit<MemoryRecord, "body" | "thoughts"> {
  snippet: string;
  thoughtsSnippet?: string;
  reasons: string[];
}
export interface MemoryPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface VaultIngestNote {
  path: string;
  title: string;
  body: string;
  sourceHash: string;
  modifiedAt: string;
  historical: boolean;
  tags?: string[];
  links?: string[];
}
export interface VaultIngestScan {
  notes: VaultIngestNote[];
  complete: boolean;
  unavailablePaths: string[];
  unavailablePrefixes: string[];
  scannedAt: string;
  status: "ready" | "partial" | "unavailable";
  reason?: "limit" | "io" | "changed" | "missing";
}
export interface MemorySnapshot {
  capturedAt: string;
  settings: MemorySettings;
  core: MemoryRecord[];
  retrieved: MemoryRecord[];
  topics: MemorySearchItem[];
  estimatedTokens: number;
  coreTokens: number;
  retrievedTokens: number;
  topicTokens: number;
  coreOverBudget: boolean;
  content: string;
}
export interface ConversationSearchItem {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  observedAt: string;
  snippet: string;
  truncated: boolean;
}
export interface ConversationEvidence {
  id: string;
  turnId: string;
  role: "user" | "assistant";
  observedAt: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  truncated: boolean;
}
export interface MemoryStatus {
  settings: MemorySettings;
  coreTokens: number;
  coreOverBudget: boolean;
  activeRecords: number;
  coreRecords: number;
  shortRecords: number;
  archivedRecords: number;
  vaultNotes: number;
  vault: Omit<VaultIngestScan, "notes" | "unavailablePaths" | "unavailablePrefixes"> | null;
}
