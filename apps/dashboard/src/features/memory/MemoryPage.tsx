import type {
  ConversationSearchItem,
  MemoryRecord,
  MemorySearchItem,
  MemorySettings,
  MemoryStatus,
  NoteLibraryPage,
  MemoryPage as Page,
} from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice, formattedTime } from "../../components/ui";
import { ConversationSource } from "./ConversationSource";
import { NotesBrowser } from "./NotesBrowser";
import {
  applyRecallPreset,
  humanToolName,
  type MemorySourceFilter,
  memoryDescription,
  memoryDraftIssues,
  memoryLabel,
  readableMemorySnippet,
  recallPresetId,
  recallPresets,
  recordCanBeEdited,
} from "./presentation";

type Screen = "overview" | "detail" | "editor" | "settings" | "activity";
type MemoryDraft = { title: string; body: string; thoughts: string; tier: "short" | "core" };
type MemoryDetail = MemoryRecord & {
  nextOffset?: number | null;
  truncated?: boolean;
  currentVersion?: number;
  currentState?: MemoryRecord["state"];
  currentHistorical?: boolean;
};
type Recall = {
  id: string;
  receivedAt: string;
  core: { id: string; title: string; version: number }[];
  retrieved: { id: string; title: string; version: number }[];
  topics: { id: string; title: string; version: number }[];
  outcomes: { id: string; name: string; status: string; code: string | null }[];
};

const blankMemory: MemoryDraft = { title: "", body: "", thoughts: "", tier: "short" };
const sourceFilters: { id: MemorySourceFilter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "records", label: "Saved memories" },
  { id: "vault", label: "Long-term notes" },
  { id: "conversations", label: "Conversations" },
];
const sameBudgets = (left: MemorySettings, right: MemorySettings) =>
  left.coreTokens === right.coreTokens &&
  left.retrievedTokens === right.retrievedTokens &&
  left.topicTokens === right.topicTokens;

function MemoryRows({
  items,
  busy,
  onOpen,
}: {
  items: MemorySearchItem[];
  busy: boolean;
  onOpen: (item: MemorySearchItem) => void;
}) {
  return (
    <ul className="memory-card-list">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="memory-card"
            disabled={busy}
            onClick={() => onOpen(item)}
          >
            <span className="memory-card-heading">
              <strong>{item.title}</strong>
              <Badge tone={item.tier === "core" && item.state === "active" ? "accent" : "neutral"}>
                {memoryLabel(item)}
              </Badge>
            </span>
            <span className="memory-card-snippet">{readableMemorySnippet(item.snippet)}</span>
            {item.thoughtsSnippet && (
              <span className="memory-card-thoughts">
                <strong>Thoughts: </strong>
                {readableMemorySnippet(item.thoughtsSnippet)}
              </span>
            )}
            <span className="memory-card-meta">{memoryDescription(item)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PageControls({
  page,
  cursor,
  onNext,
  onFirst,
}: {
  page: Page<unknown> | null;
  cursor: string;
  onNext: () => void;
  onFirst: () => void;
}) {
  if (!page?.nextCursor && !cursor) return null;
  return (
    <div className="memory-page-controls">
      {cursor && (
        <button type="button" className="text-button" onClick={onFirst}>
          First page
        </button>
      )}
      {page?.nextCursor && (
        <button type="button" className="text-button" onClick={onNext}>
          Next page
        </button>
      )}
    </div>
  );
}

export function MemoryPage({
  api,
  onDirtyChange,
  visible,
}: {
  api: Api;
  onDirtyChange: (dirty: boolean) => void;
  visible: boolean;
}) {
  const [screen, setScreen] = useState<Screen>("overview");
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [saved, setSaved] = useState<Page<MemorySearchItem> | null>(null);
  const [library, setLibrary] = useState<NoteLibraryPage | null>(null);
  const [noteFolder, setNoteFolder] = useState("Notes");
  const [recall, setRecall] = useState<Recall[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<MemorySourceFilter>("all");
  const [recordTier, setRecordTier] = useState<"" | "core" | "short">("");
  const [includeArchive, setIncludeArchive] = useState(false);
  const [memoryCursor, setMemoryCursor] = useState("");
  const [conversationCursor, setConversationCursor] = useState("");
  const [memoryResults, setMemoryResults] = useState<Page<MemorySearchItem> | null>(null);
  const [conversationResults, setConversationResults] =
    useState<Page<ConversationSearchItem> | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [selected, setSelected] = useState<MemoryDetail | null>(null);
  const [latestVersion, setLatestVersion] = useState(1);
  const [editorTarget, setEditorTarget] = useState<MemoryDetail | null>(null);
  const [editorBase, setEditorBase] = useState<MemoryDraft>(blankMemory);
  const [draft, setDraft] = useState<MemoryDraft>(blankMemory);
  const [budgets, setBudgets] = useState<{ saved: MemorySettings; draft: MemorySettings } | null>(
    null,
  );
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const normalizedQuery = query.trim().slice(0, 200);
  const searchActive =
    normalizedQuery.length > 0 || source !== "all" || includeArchive || memoryCursor !== "";
  const editorDirty =
    screen === "editor" &&
    (draft.title !== editorBase.title ||
      draft.body !== editorBase.body ||
      draft.thoughts !== editorBase.thoughts ||
      draft.tier !== editorBase.tier);
  const draftIssues = memoryDraftIssues(draft);
  const draftTooLong = Object.values(draftIssues).some(Boolean);
  const budgetDirty = Boolean(budgets && !sameBudgets(budgets.saved, budgets.draft));
  const dirty = editorDirty || budgetDirty;
  const historicalRevision = Boolean(selected && selected.version < latestVersion);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly reloads saved server state.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setError("");
    setOverviewLoading(true);
    Promise.all([
      api<MemoryStatus>("/memory/status", { signal: controller.signal }),
      api<Page<MemorySearchItem>>("/memory/search?q=&source=records&includeArchive=false&limit=4", {
        signal: controller.signal,
      }),
      api<NoteLibraryPage>("/memory/notes?folder=Notes", { signal: controller.signal }),
      api<Recall[]>("/memory/recall", { signal: controller.signal }),
    ])
      .then(([currentStatus, currentSaved, currentLibrary, recentRecall]) => {
        if (controller.signal.aborted) return;
        setStatus(currentStatus);
        setSaved(currentSaved);
        setLibrary(currentLibrary);
        setRecall(recentRecall);
        setBudgets((previous) =>
          !previous || sameBudgets(previous.saved, previous.draft)
            ? { saved: currentStatus.settings, draft: currentStatus.settings }
            : previous,
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setOverviewLoading(false);
      });
    return () => controller.abort();
  }, [api, refresh, visible]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh explicitly reruns the current search.
  useEffect(() => {
    if (!visible || !searchActive || source === "vault") {
      setMemoryResults(null);
      setConversationResults(null);
      setResultsLoading(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (source === "conversations" && !normalizedQuery) {
        setMemoryResults(null);
        setConversationResults(null);
        setResultsLoading(false);
        return;
      }
      setError("");
      setMemoryResults(null);
      setConversationResults(null);
      setResultsLoading(true);
      const memoryRequest =
        source === "conversations"
          ? Promise.resolve(null)
          : (() => {
              const params = new URLSearchParams({
                q: normalizedQuery,
                source: source === "all" ? "all" : source,
                includeArchive: String(includeArchive),
                limit: "8",
              });
              if (memoryCursor) params.set("cursor", memoryCursor);
              if (source === "records" && recordTier) params.set("tier", recordTier);
              return api<Page<MemorySearchItem>>(`/memory/search?${params}`, {
                signal: controller.signal,
              });
            })();
      const conversationRequest =
        normalizedQuery && (source === "all" || source === "conversations")
          ? (() => {
              const params = new URLSearchParams({ q: normalizedQuery, limit: "6" });
              if (conversationCursor) params.set("cursor", conversationCursor);
              return api<Page<ConversationSearchItem>>(`/memory/conversations?${params}`, {
                signal: controller.signal,
              });
            })()
          : Promise.resolve(null);
      Promise.all([memoryRequest, conversationRequest])
        .then(([memories, conversations]) => {
          if (controller.signal.aborted) return;
          setMemoryResults(memories);
          setConversationResults(conversations);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) setError(errorMessage(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setResultsLoading(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    api,
    normalizedQuery,
    source,
    recordTier,
    includeArchive,
    memoryCursor,
    conversationCursor,
    refresh,
    searchActive,
    visible,
  ]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function refreshSavedData() {
    setMemoryCursor("");
    setConversationCursor("");
    setRefresh((value) => value + 1);
  }

  function chooseSource(next: MemorySourceFilter) {
    setSource(next);
    setRecordTier("");
    setMemoryCursor("");
    setConversationCursor("");
  }
  function openFolder(path: string) {
    setNoteFolder(path);
    setQuery("");
    chooseSource("vault");
  }

  function clearSearch() {
    setQuery("");
    setSource("all");
    setRecordTier("");
    setIncludeArchive(false);
    setMemoryCursor("");
    setConversationCursor("");
  }

  async function openMemory(item: Pick<MemorySearchItem, "id" | "state" | "historical">) {
    await run(async () => {
      const includeHistorical = includeArchive || item.state !== "active" || item.historical;
      const record = await api<MemoryDetail>(
        `/memory/records/${encodeURIComponent(item.id)}?includeArchive=${includeHistorical}`,
      );
      setSelected(record);
      setLatestVersion(record.currentVersion ?? record.version);
      setScreen("detail");
    });
  }

  function openEditor(record: MemoryDetail | null) {
    const nextDraft = record
      ? {
          title: record.title,
          body: record.body,
          thoughts: record.thoughts ?? "",
          tier: record.tier === "core" ? ("core" as const) : ("short" as const),
        }
      : blankMemory;
    setEditorTarget(record);
    setEditorBase(nextDraft);
    setDraft(nextDraft);
    setScreen("editor");
  }

  function returnToMemory() {
    setScreen("overview");
    setSelected(null);
    setEditorTarget(null);
    setEditorBase(blankMemory);
    setDraft(blankMemory);
    if (budgets) setBudgets({ saved: budgets.saved, draft: budgets.saved });
  }

  const memoryReady =
    status && !status.coreOverBudget && (status.vault === null || status.vault.status === "ready");
  const resultsEmpty =
    !resultsLoading &&
    (memoryResults?.items.length ?? 0) === 0 &&
    (conversationResults?.items.length ?? 0) === 0;
  const searchPlaceholder =
    source === "records"
      ? "Search saved memories…"
      : source === "vault"
        ? noteFolder
          ? `Search ${noteFolder.split("/").at(-1)}…`
          : "Search all note collections…"
        : source === "conversations"
          ? "Search older conversations…"
          : "Search people, preferences, projects, or conversations…";

  return (
    <section className="page memory-page" aria-labelledby="memory-title">
      <div className="page-heading memory-page-heading">
        <div>
          <h1 id="memory-title">Memory</h1>
          <p className="page-description">
            Your saved memories, notes, and conversation history in one place.
          </p>
        </div>
        {screen === "overview" ? (
          <div className="memory-heading-actions">
            <button
              type="button"
              className="button button--secondary"
              disabled={busy || dirty}
              onClick={() => setScreen("settings")}
            >
              Memory settings
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy || dirty}
              onClick={() => openEditor(null)}
            >
              Add memory
            </button>
          </div>
        ) : (
          <button type="button" className="button button--secondary" onClick={returnToMemory}>
            {dirty ? "Discard and go back" : "Back to memory"}
          </button>
        )}
      </div>

      {error && (
        <ErrorNotice message={error}>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setError("");
              refreshSavedData();
            }}
          >
            Try again
          </button>
        </ErrorNotice>
      )}
      {notice && (
        <div className="notice memory-notice" role="status">
          <span className="notice-symbol" aria-hidden="true">
            ✓
          </span>
          <p>{notice}</p>
        </div>
      )}

      {screen === "overview" && (
        <>
          {!searchActive && (
            <section className={`panel memory-health ${memoryReady ? "memory-health--ready" : ""}`}>
              <span className="memory-health-mark" aria-hidden="true">
                ◇
              </span>
              <div className="memory-health-copy">
                <span className="eyebrow">
                  {overviewLoading ? "Checking memory" : memoryReady ? "Ready" : "Needs attention"}
                </span>
                <h2>
                  {overviewLoading
                    ? "Loading Valerie’s memory…"
                    : memoryReady
                      ? "Valerie’s memory is ready"
                      : "Some memory needs your attention"}
                </h2>
                <p>
                  {memoryReady
                    ? "She can use saved memories automatically and look through your notes or older conversations when they matter."
                    : "Saved memories still work. Open settings for the current note-library status and limits."}
                </p>
              </div>
              {status && (
                <div className="memory-health-counts">
                  <span>
                    <strong>{status.activeRecords}</strong> saved
                  </span>
                  <span>
                    <strong>{status.vaultNotes}</strong> notes
                  </span>
                  <span>
                    <strong>{recall.length}</strong> recent replies
                  </span>
                </div>
              )}
            </section>
          )}

          {status && (
            <fieldset className="memory-tier-overview">
              <legend className="sr-only">Memory types</legend>
              <button
                type="button"
                className="panel memory-tier-card"
                onClick={() => {
                  chooseSource("records");
                  setRecordTier("core");
                }}
              >
                <strong className="memory-tier-title">
                  Core memory <span className="memory-tier-count">{status.coreRecords ?? 0}</span>
                </strong>
                <small className="memory-tier-description">
                  You pin it. Included in every conversation.
                </small>
              </button>
              <button
                type="button"
                className="panel memory-tier-card"
                onClick={() => {
                  chooseSource("records");
                  setRecordTier("short");
                }}
              >
                <strong className="memory-tier-title">
                  Short-term memory{" "}
                  <span className="memory-tier-count">
                    {status.shortRecords ?? status.activeRecords}
                  </span>
                </strong>
                <small className="memory-tier-description">
                  Conversation notes and thoughts, normally kept for 30 days.
                </small>
              </button>
              <button
                type="button"
                className="panel memory-tier-card"
                onClick={() => openFolder("Notes")}
              >
                <strong className="memory-tier-title">
                  Long-term memory <span className="memory-tier-count">Obsidian</span>
                </strong>
                <small className="memory-tier-description">
                  {status.vaultNotes} indexed vault {status.vaultNotes === 1 ? "note" : "notes"},
                  recalled when relevant.
                </small>
              </button>
            </fieldset>
          )}

          <section className="panel memory-search-panel" aria-labelledby="memory-search-title">
            <div className="memory-search-row">
              <span className="memory-search-symbol" aria-hidden="true">
                ⌕
              </span>
              <label className="sr-only" htmlFor="memory-search">
                Search memory
              </label>
              <input
                id="memory-search"
                type="search"
                maxLength={200}
                value={query}
                placeholder={searchPlaceholder}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setMemoryCursor("");
                  setConversationCursor("");
                }}
              />
              {query && (
                <button type="button" className="text-button" onClick={clearSearch}>
                  Clear
                </button>
              )}
            </div>
            <h2 id="memory-search-title" className="sr-only">
              Find something Valerie remembers
            </h2>
            <fieldset className="memory-filter-row">
              <legend className="sr-only">Search within</legend>
              {sourceFilters.map((filter) => (
                <button
                  type="button"
                  key={filter.id}
                  className={`memory-filter ${source === filter.id ? "is-active" : ""}`}
                  aria-pressed={source === filter.id}
                  onClick={() => chooseSource(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
              {source !== "conversations" && (
                <label className="memory-archive-toggle">
                  <input
                    type="checkbox"
                    checked={includeArchive}
                    onChange={(event) => {
                      setIncludeArchive(event.target.checked);
                      setMemoryCursor("");
                      setConversationCursor("");
                    }}
                  />
                  Include archive
                </label>
              )}
            </fieldset>
            {source === "records" && (
              <fieldset className="memory-filter-row memory-tier-filter">
                <legend className="sr-only">Saved memory type</legend>
                {(
                  [
                    ["", "All saved"],
                    ["core", "Core"],
                    ["short", "Short-term"],
                  ] as const
                ).map(([tier, label]) => (
                  <button
                    type="button"
                    key={tier}
                    className={`memory-filter ${recordTier === tier ? "is-active" : ""}`}
                    aria-pressed={recordTier === tier}
                    onClick={() => {
                      setRecordTier(tier);
                      setMemoryCursor("");
                    }}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
            )}
          </section>

          {source === "vault" ? (
            <NotesBrowser
              api={api}
              folder={noteFolder}
              query={normalizedQuery}
              includeArchive={includeArchive}
              onFolder={openFolder}
              onOpen={(item) => void openMemory(item)}
              busy={busy}
              cursor={memoryCursor}
              onCursor={setMemoryCursor}
            />
          ) : searchActive ? (
            <section className="memory-search-results" aria-live="polite">
              <div className="memory-section-heading">
                <div>
                  <span className="eyebrow">Search</span>
                  <h2>
                    {normalizedQuery
                      ? `Results for “${normalizedQuery}”`
                      : source === "records"
                        ? "Saved memories"
                        : source === "conversations"
                          ? "Older conversations"
                          : "Memory archive"}
                  </h2>
                </div>
                <button type="button" className="text-button" onClick={clearSearch}>
                  Back to overview
                </button>
              </div>
              {resultsLoading && (
                <p className="muted" role="status">
                  Searching memory…
                </p>
              )}
              {!resultsLoading && source === "conversations" && !normalizedQuery && (
                <EmptyState title="What are you looking for?">
                  <p>Enter a word or phrase to search older conversations.</p>
                </EmptyState>
              )}
              {!resultsLoading && memoryResults && memoryResults.items.length > 0 && (
                <div className="panel memory-result-group">
                  <div className="memory-result-group-heading">
                    <h3>{source === "records" ? "Saved memories" : "Memories and notes"}</h3>
                    <span className="memory-result-count">
                      {memoryResults.items.length} on this page
                    </span>
                  </div>
                  <MemoryRows
                    items={memoryResults.items}
                    busy={busy}
                    onOpen={(item) => void openMemory(item)}
                  />
                  <PageControls
                    page={memoryResults}
                    cursor={memoryCursor}
                    onFirst={() => setMemoryCursor("")}
                    onNext={() => setMemoryCursor(memoryResults.nextCursor ?? "")}
                  />
                </div>
              )}
              {!resultsLoading && conversationResults && conversationResults.items.length > 0 && (
                <div className="panel memory-result-group">
                  <div className="memory-result-group-heading">
                    <h3>Conversation matches</h3>
                    <span className="memory-result-count">
                      {conversationResults.items.length} on this page
                    </span>
                  </div>
                  <ul className="memory-conversation-list">
                    {conversationResults.items.map((item) => (
                      <li className="memory-conversation-item" key={item.id}>
                        <span className="memory-conversation-speaker">
                          {item.role === "user" ? "You" : "Valerie"}
                        </span>
                        <p>{item.snippet}</p>
                        <time dateTime={item.observedAt}>{formattedTime(item.observedAt)}</time>
                      </li>
                    ))}
                  </ul>
                  <PageControls
                    page={conversationResults}
                    cursor={conversationCursor}
                    onFirst={() => setConversationCursor("")}
                    onNext={() => setConversationCursor(conversationResults.nextCursor ?? "")}
                  />
                </div>
              )}
              {resultsEmpty && !(source === "conversations" && !normalizedQuery) && (
                <EmptyState title="Nothing matched">
                  <p>Try a different phrase, another source, or include the archive.</p>
                </EmptyState>
              )}
            </section>
          ) : (
            <div className="memory-overview-grid">
              <section className="panel memory-overview-panel" aria-labelledby="saved-memory-title">
                <div className="memory-section-heading">
                  <div>
                    <span className="eyebrow">Kept close</span>
                    <h2 id="saved-memory-title">Saved memories</h2>
                  </div>
                  {status && status.activeRecords > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => chooseSource("records")}
                    >
                      View all
                    </button>
                  )}
                </div>
                {saved?.items.length ? (
                  <MemoryRows
                    items={saved.items.slice(0, 4)}
                    busy={busy}
                    onOpen={(item) => void openMemory(item)}
                  />
                ) : overviewLoading ? (
                  <p className="muted">Loading saved memories…</p>
                ) : (
                  <div className="memory-small-empty">
                    <span aria-hidden="true">◇</span>
                    <div>
                      <h3>No saved memories yet</h3>
                      <p>Add something Valerie should keep for a while or always remember.</p>
                    </div>
                    <button type="button" className="text-button" onClick={() => openEditor(null)}>
                      Add one
                    </button>
                  </div>
                )}
              </section>

              <section className="panel memory-overview-panel" aria-labelledby="library-title">
                <div className="memory-section-heading">
                  <div>
                    <span className="eyebrow">Linked notes</span>
                    <h2 id="library-title">Your note library</h2>
                  </div>
                  <button type="button" className="text-button" onClick={() => openFolder("Notes")}>
                    Browse notes
                  </button>
                </div>
                <p className="memory-section-intro">
                  Browse the same folders you use in Obsidian, with projects and collections kept
                  together.
                </p>
                {library?.folders.length ? (
                  <div className="memory-topic-grid">
                    {library.folders.slice(0, 6).map((folder) => (
                      <button
                        type="button"
                        key={folder.path}
                        disabled={busy}
                        onClick={() => openFolder(folder.path)}
                      >
                        <span aria-hidden="true">▱</span>
                        <strong>{folder.name}</strong>
                        <small>{folder.noteCount}</small>
                      </button>
                    ))}
                  </div>
                ) : overviewLoading ? (
                  <p className="muted">Loading note folders…</p>
                ) : (
                  <p className="muted">Open the library to browse other collections.</p>
                )}
              </section>

              <section className="panel memory-how" aria-labelledby="memory-how-title">
                <div className="memory-section-heading">
                  <div>
                    <span className="eyebrow">At a glance</span>
                    <h2 id="memory-how-title">How memory works</h2>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setScreen("settings")}
                  >
                    Change style
                  </button>
                </div>
                <div className="memory-how-grid">
                  <div>
                    <span className="memory-how-icon" aria-hidden="true">
                      ◆
                    </span>
                    <h3>Core memory</h3>
                    <p>Facts you pin stay available in every new conversation.</p>
                  </div>
                  <div>
                    <span className="memory-how-icon" aria-hidden="true">
                      ◷
                    </span>
                    <h3>Remembered for now</h3>
                    <p>Useful personal context stays for 30 days unless you archive it sooner.</p>
                  </div>
                  <div>
                    <span className="memory-how-icon" aria-hidden="true">
                      ⌕
                    </span>
                    <h3>Found when relevant</h3>
                    <p>Notes and older conversations are searched only when they can help.</p>
                  </div>
                </div>
              </section>

              <section className="panel memory-recent-strip" aria-labelledby="recent-memory-title">
                <div>
                  <span className="eyebrow">Recent use</span>
                  <h2 id="recent-memory-title">
                    {recall.length
                      ? `Memory supported ${recall.length} recent ${recall.length === 1 ? "reply" : "replies"}`
                      : "No replies have used memory yet"}
                  </h2>
                  <p>
                    {recall.length
                      ? "See which memories helped each reply."
                      : "This will fill in naturally as Valerie uses saved context and searches."}
                  </p>
                </div>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setScreen("activity")}
                >
                  View recent use
                </button>
              </section>
            </div>
          )}
        </>
      )}

      {screen === "detail" && selected && (
        <article className="panel memory-detail-panel">
          <header className="memory-detail-heading">
            <div>
              <Badge
                tone={
                  selected.tier === "core" && selected.state === "active" ? "accent" : "neutral"
                }
              >
                {memoryLabel(selected)}
              </Badge>
              <h2>{selected.title}</h2>
              <p>
                {(selected.currentState ?? selected.state) !== "active" ||
                (selected.currentHistorical ?? selected.historical)
                  ? "Archived context; excluded from ordinary recall"
                  : historicalRevision
                    ? "Earlier version; the current version is used for recall"
                    : selected.source === "vault"
                      ? "From your Obsidian notes"
                      : selected.tier === "core"
                        ? "Available in every new conversation"
                        : selected.expiresAt
                          ? `Kept until ${formattedTime(selected.expiresAt)}`
                          : "Short-term context"}
              </p>
            </div>
            <div className="memory-detail-actions">
              {selected.source === "records" && recordCanBeEdited(selected, latestVersion) && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => openEditor(selected)}
                >
                  {selected.state === "active" ? "Edit memory" : "Restore memory"}
                </button>
              )}
              {selected.source === "records" &&
                selected.state === "active" &&
                !historicalRevision && (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api(`/memory/records/${encodeURIComponent(selected.id)}/archive`, {
                          method: "POST",
                          body: JSON.stringify({ expectedVersion: selected.version }),
                        });
                        returnToMemory();
                        refreshSavedData();
                        setNotice("Memory moved to the archive.");
                      })
                    }
                  >
                    Archive
                  </button>
                )}
            </div>
          </header>
          {historicalRevision && (
            <div className="memory-history-banner">
              You’re viewing an older version. The current memory is version {latestVersion}.
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void run(async () => {
                    const current = await api<MemoryDetail>(
                      `/memory/records/${encodeURIComponent(selected.id)}?includeArchive=true`,
                    );
                    setSelected(current);
                  })
                }
              >
                View current version
              </button>
            </div>
          )}
          {selected.source === "records" && (
            <h3 className="memory-reading-label">Memory summary</h3>
          )}
          <div className="memory-reading-copy">{selected.body}</div>
          {selected.thoughts && (
            <section className="memory-thoughts" aria-label="Memory thoughts">
              <h3>
                {selected.authoredBy === "valerie" ? "Valerie’s thoughts" : "Additional thoughts"}
              </h3>
              <p className="muted">Interpretation and ideas, separate from the sourced facts.</p>
              <div className="memory-reading-copy">{selected.thoughts}</div>
            </section>
          )}
          {selected.nextOffset != null && (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const more = await api<MemoryDetail>(
                    `/memory/records/${encodeURIComponent(selected.id)}?version=${selected.version}&offset=${selected.nextOffset}&includeArchive=true`,
                  );
                  setSelected({ ...more, body: selected.body + more.body });
                })
              }
            >
              Continue reading
            </button>
          )}
          <footer className="memory-detail-footer">
            <div>
              <strong>
                {selected.source === "vault"
                  ? "This note stays in Obsidian"
                  : "Saved directly in Valerie"}
              </strong>
              <p>
                {selected.source === "vault"
                  ? "Edit it in Obsidian; Valerie picks up the synced change automatically."
                  : "Edits create a new version. Earlier versions and their evidence remain available in history."}
              </p>
            </div>
            <details>
              <summary>History and source</summary>
              <dl className="memory-source-list">
                <div>
                  <dt>Current state</dt>
                  <dd>{(selected.currentState ?? selected.state).replaceAll("_", " ")}</dd>
                </div>
                <div>
                  <dt>Version</dt>
                  <dd>
                    {selected.version} of {latestVersion}
                  </dd>
                </div>
                {selected.sourcePath && (
                  <div>
                    <dt>Note</dt>
                    <dd>{selected.sourcePath}</dd>
                  </div>
                )}
                {selected.expiresAt && (
                  <div>
                    <dt>Kept until</dt>
                    <dd>{formattedTime(selected.expiresAt)}</dd>
                  </div>
                )}
              </dl>
              {selected.provenance.map((item) => (
                <div key={`${item.sourceType}:${item.sourceId}`}>
                  <p className="muted">
                    From{" "}
                    {item.sourceType === "owner"
                      ? "a memory you saved"
                      : item.sourceType === "conversation"
                        ? "your conversation"
                        : "your note library"}{" "}
                    on {formattedTime(item.observedAt)}
                    {item.quote ? `: “${item.quote}”` : ""}
                  </p>
                  {item.sourceType === "conversation" && (
                    <ConversationSource api={api} id={item.sourceId} />
                  )}
                </div>
              ))}
              {selected.provenanceTruncated && (
                <p className="muted">
                  Some earlier source links are retained in previous versions.
                </p>
              )}
              {latestVersion > 1 && (
                <label className="memory-version-control">
                  View an earlier version
                  <input
                    type="number"
                    min="1"
                    max={latestVersion}
                    value={selected.version}
                    disabled={busy}
                    onChange={(event) => {
                      const version = Number(event.target.value);
                      if (!Number.isSafeInteger(version) || version < 1 || version > latestVersion)
                        return;
                      void run(async () => {
                        const record = await api<MemoryDetail>(
                          `/memory/records/${encodeURIComponent(selected.id)}?version=${version}&includeArchive=true`,
                        );
                        setSelected(record);
                      });
                    }}
                  />
                </label>
              )}
            </details>
          </footer>
        </article>
      )}

      {screen === "editor" && (
        <section className="panel memory-form-panel" aria-labelledby="memory-form-title">
          <div className="memory-form-heading">
            <span className="eyebrow">{editorTarget ? "Saved memory" : "New memory"}</span>
            <h2 id="memory-form-title">
              {editorTarget
                ? editorTarget.state === "active"
                  ? "Edit what Valerie remembers"
                  : "Restore this memory"
                : "What should Valerie remember?"}
            </h2>
            <p>Keep it short and concrete. You can change or archive it later.</p>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (draftTooLong) return;
              void run(async () => {
                const record = await api<MemoryDetail>(
                  editorTarget
                    ? `/memory/records/${encodeURIComponent(editorTarget.id)}`
                    : "/memory/records",
                  {
                    method: editorTarget ? "PUT" : "POST",
                    body: JSON.stringify({
                      ...draft,
                      kind: editorTarget?.kind ?? "fact",
                      expectedVersion: editorTarget?.version,
                    }),
                  },
                );
                const message =
                  editorTarget?.state === "active"
                    ? "Memory updated."
                    : editorTarget
                      ? "Memory restored."
                      : "Memory saved.";
                setSelected(record);
                setLatestVersion(record.version);
                setEditorTarget(null);
                setEditorBase(blankMemory);
                setDraft(blankMemory);
                setScreen("detail");
                refreshSavedData();
                setNotice(message);
              });
            }}
          >
            <label className="memory-field">
              <span className="memory-field-label">Short label</span>
              <small>A name you’ll recognize in search, such as “Morning check-ins.”</small>
              <input
                required
                maxLength={160}
                disabled={busy}
                value={draft.title}
                aria-invalid={Boolean(draftIssues.title)}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
              {draftIssues.title && (
                <small role="alert" className="memory-field-error">
                  {draftIssues.title}
                </small>
              )}
            </label>
            <label className="memory-field">
              <span className="memory-field-label">What should Valerie remember?</span>
              <small>Write the fact or preference in your own words.</small>
              <textarea
                required
                rows={7}
                maxLength={8000}
                disabled={busy}
                value={draft.body}
                aria-invalid={Boolean(draftIssues.body)}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              />
              {draftIssues.body && (
                <small role="alert" className="memory-field-error">
                  {draftIssues.body}
                </small>
              )}
            </label>
            <label className="memory-field">
              <span className="memory-field-label">Additional thoughts</span>
              <small>Optional interpretation or ideas, kept separate from the summary.</small>
              <textarea
                rows={4}
                maxLength={1000}
                disabled={busy}
                value={draft.thoughts}
                aria-invalid={Boolean(draftIssues.thoughts)}
                onChange={(event) => setDraft({ ...draft, thoughts: event.target.value })}
              />
              {draftIssues.thoughts && (
                <small role="alert" className="memory-field-error">
                  {draftIssues.thoughts}
                </small>
              )}
            </label>
            <fieldset className="memory-duration-choices">
              <legend>How long should she keep it close?</legend>
              <label className={draft.tier === "short" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="memory-duration"
                  value="short"
                  checked={draft.tier === "short"}
                  disabled={busy}
                  onChange={() => setDraft({ ...draft, tier: "short" })}
                />
                <span className="memory-duration-icon" aria-hidden="true">
                  ◷
                </span>
                <strong className="memory-duration-title">Short-term memory</strong>
                <small className="memory-duration-copy">
                  Available for 30 days. Good for current interests and temporary context.
                </small>
              </label>
              <label className={draft.tier === "core" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="memory-duration"
                  value="core"
                  checked={draft.tier === "core"}
                  disabled={busy}
                  onChange={() => setDraft({ ...draft, tier: "core" })}
                />
                <span className="memory-duration-icon" aria-hidden="true">
                  ◆
                </span>
                <strong className="memory-duration-title">Core memory</strong>
                <small className="memory-duration-copy">
                  Included in every new conversation until you archive it.
                </small>
              </label>
            </fieldset>
            <p className="muted">Long-term notes live in Obsidian and are edited there.</p>
            <div className="memory-form-actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || draftTooLong || !draft.title.trim() || !draft.body.trim()}
              >
                {busy
                  ? "Saving…"
                  : editorTarget?.state === "active"
                    ? "Save changes"
                    : editorTarget
                      ? "Restore memory"
                      : "Save memory"}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => {
                  if (editorTarget) {
                    setSelected(editorTarget);
                    setScreen("detail");
                  } else returnToMemory();
                  setEditorBase(blankMemory);
                  setDraft(blankMemory);
                }}
              >
                {editorDirty ? "Discard changes" : "Cancel"}
              </button>
            </div>
          </form>
        </section>
      )}

      {screen === "settings" && status && budgets && (
        <section className="memory-settings-view" aria-labelledby="memory-settings-title">
          <div className="panel memory-settings-panel">
            <div className="memory-form-heading">
              <span className="eyebrow">Memory style</span>
              <h2 id="memory-settings-title">
                How much background should Valerie bring into a reply?
              </h2>
              <p>
                Balanced is the current default. A larger setting can help with complicated topics,
                while Focused keeps replies lean.
              </p>
            </div>
            <div className="memory-preset-grid" role="radiogroup" aria-label="Memory style">
              {recallPresets.map((preset) => (
                <label
                  key={preset.id}
                  className={recallPresetId(budgets.draft) === preset.id ? "is-selected" : ""}
                >
                  <input
                    type="radio"
                    name="recall-preset"
                    value={preset.id}
                    checked={recallPresetId(budgets.draft) === preset.id}
                    disabled={busy}
                    onChange={() =>
                      setBudgets({
                        ...budgets,
                        draft: applyRecallPreset(budgets.draft, preset.id),
                      })
                    }
                  />
                  <strong className="memory-preset-title">{preset.title}</strong>
                  <span className="memory-preset-copy">{preset.description}</span>
                </label>
              ))}
              {recallPresetId(budgets.draft) === "custom" && (
                <div className="memory-custom-preset">
                  <strong className="memory-preset-title">Custom</strong>
                  <span className="memory-preset-copy">
                    Your advanced limits don’t match a preset.
                  </span>
                </div>
              )}
            </div>
            {status.coreOverBudget && (
              <ErrorNotice message="Always-remembered memories need more room than the current setting. Choose a larger style or archive a pinned memory." />
            )}
            <details className="memory-advanced-settings">
              <summary>Advanced limits</summary>
              <p>
                These limits divide the space available in each request. Higher numbers leave more
                room for memory and less for recent conversation.
              </p>
              <div className="memory-advanced-grid">
                <label>
                  <span className="memory-advanced-label">Always-remembered space</span>
                  <small>Facts included in every new conversation.</small>
                  <input
                    type="number"
                    min="0"
                    max="32000"
                    value={budgets.draft.coreTokens}
                    disabled={busy}
                    onChange={(event) =>
                      setBudgets({
                        ...budgets,
                        draft: { ...budgets.draft, coreTokens: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  <span className="memory-advanced-label">Related-memory space</span>
                  <small>Details pulled in when they match the current topic.</small>
                  <input
                    type="number"
                    min="0"
                    max="32000"
                    value={budgets.draft.retrievedTokens}
                    disabled={busy}
                    onChange={(event) =>
                      setBudgets({
                        ...budgets,
                        draft: { ...budgets.draft, retrievedTokens: Number(event.target.value) },
                      })
                    }
                  />
                </label>
                <label>
                  <span className="memory-advanced-label">Topic-guide space</span>
                  <small>Small topic summaries that point Valerie toward deeper notes.</small>
                  <input
                    type="number"
                    min="0"
                    max="32000"
                    value={budgets.draft.topicTokens}
                    disabled={busy}
                    onChange={(event) =>
                      setBudgets({
                        ...budgets,
                        draft: { ...budgets.draft, topicTokens: Number(event.target.value) },
                      })
                    }
                  />
                </label>
              </div>
              <p className="muted">
                Advanced limits use conservative context units. Current always-remembered memories
                use {status.coreTokens}.
              </p>
            </details>
            <div className="memory-form-actions">
              <button
                type="button"
                className="button button--primary"
                disabled={busy || !budgetDirty}
                onClick={() =>
                  void run(async () => {
                    const savedSettings = await api<MemorySettings>("/memory/settings", {
                      method: "PUT",
                      body: JSON.stringify({
                        ...budgets.draft,
                        expectedVersion: budgets.draft.version,
                      }),
                    });
                    setBudgets({ saved: savedSettings, draft: savedSettings });
                    refreshSavedData();
                    setNotice("Memory settings saved for the next reply.");
                    setScreen("overview");
                  })
                }
              >
                {busy ? "Saving…" : "Save settings"}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={returnToMemory}
              >
                {budgetDirty ? "Discard changes" : "Cancel"}
              </button>
            </div>
          </div>
          <aside className="panel memory-source-status" aria-label="Memory sources">
            <h2>What Valerie can use</h2>
            <div>
              <span aria-hidden="true">◆</span>
              <p className="memory-source-copy">
                <strong className="memory-source-title">Saved memories</strong>
                <small className="memory-source-meta">{status.activeRecords} available now</small>
              </p>
              <Badge tone="success">Ready</Badge>
            </div>
            <div>
              <span aria-hidden="true">◇</span>
              <p className="memory-source-copy">
                <strong className="memory-source-title">Obsidian notes</strong>
                <small className="memory-source-meta">
                  {status.vaultNotes} approved notes · checked{" "}
                  {status.vault ? formattedTime(status.vault.scannedAt) : "not connected"}
                </small>
              </p>
              <Badge tone={status.vault?.status === "ready" ? "success" : "warning"}>
                {status.vault?.status === "ready" ? "Ready" : "Check status"}
              </Badge>
            </div>
            <div>
              <span aria-hidden="true">⌕</span>
              <p className="memory-source-copy">
                <strong className="memory-source-title">Older conversations</strong>
                <small className="memory-source-meta">
                  Searched only when the current topic needs them
                </small>
              </p>
              <Badge tone="success">Ready</Badge>
            </div>
            <p className="memory-source-note">
              Notes remain read-only here. Archived memories are only used when you explicitly
              include the archive.
            </p>
          </aside>
        </section>
      )}

      {screen === "activity" && (
        <section className="panel memory-activity-view" aria-labelledby="memory-activity-title">
          <div className="memory-form-heading">
            <span className="eyebrow">Recent use</span>
            <h2 id="memory-activity-title">Where memory helped</h2>
            <p>This shows which saved memories and searches helped recent replies.</p>
          </div>
          {recall.length ? (
            <ol className="memory-activity-list">
              {recall.map((turn) => {
                const selectedCount = turn.core.length + turn.retrieved.length + turn.topics.length;
                return (
                  <li className="memory-activity-item" key={turn.id}>
                    <div className="memory-activity-marker" aria-hidden="true">
                      ◇
                    </div>
                    <div>
                      <time dateTime={turn.receivedAt}>{formattedTime(turn.receivedAt)}</time>
                      <h3>
                        {selectedCount
                          ? `${selectedCount} ${selectedCount === 1 ? "memory" : "memories"} supported this reply`
                          : turn.outcomes.length
                            ? "Valerie searched for context"
                            : "No memory was needed"}
                      </h3>
                      {turn.outcomes.length > 0 && (
                        <p>
                          {turn.outcomes.map((outcome) => humanToolName(outcome.name)).join(" · ")}
                        </p>
                      )}
                      {(selectedCount > 0 || turn.outcomes.length > 0) && (
                        <details>
                          <summary>See details</summary>
                          {(["core", "retrieved", "topics"] as const).flatMap((bucket) =>
                            turn[bucket].map((item) => (
                              <p key={`${bucket}:${item.id}`}>{item.title}</p>
                            )),
                          )}
                          {turn.outcomes.map((outcome) => (
                            <p key={outcome.id}>
                              {humanToolName(outcome.name)} ·{" "}
                              {outcome.status === "succeeded" ? "completed" : outcome.status}
                            </p>
                          ))}
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <EmptyState title="No recent memory use">
              <p>When Valerie uses saved context or searches, you’ll see a simple record here.</p>
            </EmptyState>
          )}
        </section>
      )}
    </section>
  );
}
