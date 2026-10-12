import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, EmptyState, ErrorNotice, formattedTime } from "../../components/ui";
import type { Prompt, PromptRevision } from "./types";

export function PromptHistory({
  api,
  prompt,
  onUseRevision,
  idPrefix = "prompt",
}: {
  api: Api;
  prompt: Prompt;
  onUseRevision: (content: string) => void;
  idPrefix?: string;
}) {
  const [revisions, setRevisions] = useState<PromptRevision[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: New saved versions and manual retries invalidate this history request.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<{ revisions: PromptRevision[] }>(`/prompts/${encodeURIComponent(prompt.id)}/history`, {
      signal: controller.signal,
    })
      .then(({ revisions: items }) => {
        setRevisions([...items].sort((a, b) => b.version - a.version));
        setSelectedVersion(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, prompt.id, prompt.version, refresh]);

  const selected =
    revisions.find((revision) => revision.version === selectedVersion) ?? revisions[0];

  if (loading)
    return (
      <p className="panel-padding muted" role="status">
        Loading saved versions…
      </p>
    );
  if (error)
    return (
      <div className="panel-padding">
        <ErrorNotice message={error}>
          <button
            type="button"
            className="text-button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </button>
        </ErrorNotice>
      </div>
    );
  if (!selected)
    return (
      <EmptyState title="No saved versions yet">
        <p>This prompt’s revisions will appear here after saving.</p>
      </EmptyState>
    );

  return (
    <div className="history-view">
      <div className="history-toolbar">
        <label className="field-label" htmlFor={`${idPrefix}-revision-select`}>
          Saved version
        </label>
        <select
          id={`${idPrefix}-revision-select`}
          value={selected.version}
          onChange={(event) => setSelectedVersion(Number(event.target.value))}
        >
          {revisions.map((revision) => (
            <option key={revision.version} value={revision.version}>
              Version {revision.version} · {formattedTime(revision.createdAt)}
            </option>
          ))}
        </select>
        <Badge>Read only</Badge>
      </div>
      <textarea
        className="prompt-reading"
        aria-label="Saved prompt text"
        readOnly
        value={selected.content || "(This version is empty.)"}
      />
      <div className="editor-footer">
        <p>Opening a version does not change the active prompt.</p>
        <button
          type="button"
          className="button button--secondary"
          onClick={() => onUseRevision(selected.content)}
        >
          Use as draft
        </button>
      </div>
    </div>
  );
}
