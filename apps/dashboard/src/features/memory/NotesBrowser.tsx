import type { MemorySearchItem, NoteLibraryPage } from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { readableMemorySnippet } from "./presentation";

export function NotesBrowser({
  api,
  folder,
  query,
  includeArchive,
  onFolder,
  onOpen,
  busy,
  cursor,
  onCursor,
}: {
  api: Api;
  folder: string;
  query: string;
  includeArchive: boolean;
  onFolder: (path: string) => void;
  onOpen: (item: MemorySearchItem) => void;
  busy: boolean;
  cursor: string;
  onCursor: (cursor: string) => void;
}) {
  const [page, setPage] = useState<NoteLibraryPage | null>(null);
  const [resolvedKey, setResolvedKey] = useState("");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scope = JSON.stringify([folder, query, includeArchive]);
  const requestKey = JSON.stringify([scope, cursor, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    const params = new URLSearchParams({
      folder,
      q: query,
      includeArchive: String(includeArchive),
      limit: "8",
      cursor,
    });
    const timer = window.setTimeout(
      () => {
        api<NoteLibraryPage>(`/memory/notes?${params}`, { signal: controller.signal })
          .then((result) => {
            if (controller.signal.aborted) return;
            setPage(result);
            setResolvedKey(requestKey);
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted) setError(errorMessage(cause));
          });
      },
      query ? 200 : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, folder, query, includeArchive, cursor, requestKey]);
  const ready = page !== null && resolvedKey === requestKey;
  const parts = folder ? folder.split("/") : [];
  return (
    <section className="note-library" aria-labelledby="note-library-title">
      <nav aria-label="Note folders" className="note-breadcrumbs">
        <button
          type="button"
          onClick={() => onFolder("")}
          aria-current={!folder ? "page" : undefined}
        >
          All collections
        </button>
        {parts.map((name, index) => {
          const path = parts.slice(0, index + 1).join("/");
          return (
            <span key={path}>
              <span aria-hidden="true">/</span>
              <button
                type="button"
                onClick={() => onFolder(path)}
                aria-current={path === folder ? "page" : undefined}
              >
                {name}
              </button>
            </span>
          );
        })}
      </nav>
      <div className="memory-section-heading">
        <div>
          <h2 id="note-library-title">{parts.at(-1) ?? "All collections"}</h2>
          <p className="memory-section-intro">
            {query
              ? `Matches for “${query}” in this folder and its subfolders.`
              : ready && page.folders.length === 0
                ? "The notes in this collection, sorted by title."
                : "Your Obsidian folders. Counts include the notes in their subfolders."}
          </p>
        </div>
        {ready && (
          <span className="note-library-count">
            {page.noteCount} {page.noteCount === 1 ? "note" : "notes"} total
          </span>
        )}
      </div>
      {error ? (
        <ErrorNotice message={error}>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              onCursor("");
              setRefresh((value) => value + 1);
            }}
          >
            Refresh folder
          </button>
        </ErrorNotice>
      ) : !ready ? (
        <p role="status" className="muted">
          Loading folder…
        </p>
      ) : (
        <>
          {!query && page.folders.length > 0 && (
            <section className="note-folders" aria-label="Subfolders">
              {page.folders.map((child) => (
                <button
                  type="button"
                  key={child.path}
                  className="note-folder-card"
                  onClick={() => onFolder(child.path)}
                >
                  <span className="note-folder-icon" aria-hidden="true">
                    ▱
                  </span>
                  <span>
                    <strong>{child.name}</strong>
                    <small>
                      {child.noteCount} {child.noteCount === 1 ? "note" : "notes"}
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </section>
          )}
          {page.items.length > 0 && (
            <div className="panel note-folder-documents">
              <div className="memory-result-group-heading">
                <h3>{query ? "Matching notes" : "Notes in this folder"}</h3>
                <span className="memory-result-count">
                  {page.items.length}
                  {cursor || page.nextCursor
                    ? " on this page"
                    : page.items.length === 1
                      ? " note here"
                      : " notes here"}
                </span>
              </div>
              <ul className="memory-card-list">
                {page.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="memory-card"
                      disabled={busy}
                      onClick={() => onOpen(item)}
                    >
                      <span className="memory-card-heading">
                        <strong>{item.title}</strong>
                        <span aria-hidden="true">↗</span>
                      </span>
                      <span className="memory-card-snippet">
                        {readableMemorySnippet(item.snippet)}
                      </span>
                      {query && (
                        <span className="memory-card-meta">
                          {item.sourcePath?.split("/").slice(0, -1).join(" / ")}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              {(cursor || page.nextCursor) && (
                <div className="memory-page-controls">
                  {cursor && (
                    <button type="button" className="text-button" onClick={() => onCursor("")}>
                      First page
                    </button>
                  )}
                  {page.nextCursor && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onCursor(page.nextCursor ?? "")}
                    >
                      Next page
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {page.items.length === 0 && (query || page.folders.length === 0) && (
            <div className="panel note-folder-empty">
              <h3>{query ? "No matching notes here" : "No notes in this folder"}</h3>
              <p className="muted">
                {query
                  ? "Try another phrase, or use the breadcrumbs to search a broader collection."
                  : "Notes will appear here when they are available in your synced vault."}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
