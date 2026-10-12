import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import type { Channel, PromptPreview as Preview } from "./types";

export function PromptPreview({
  api,
  revision,
  onClose,
}: {
  api: Api;
  revision: number;
  onClose: () => void;
}) {
  const [channel, setChannel] = useState<Channel>("telegram-text");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: A saved revision or manual retry must rebuild the preview.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<Preview>(`/prompts/preview?channel=${encodeURIComponent(channel)}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) setPreview(next);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, channel, revision, refresh]);

  return (
    <section className="panel preview-panel" aria-labelledby="preview-title">
      <div className="panel-heading">
        <div>
          <h2 id="preview-title">Channel preview</h2>
          <p>
            Saved sections use their titles as # Markdown headings and follow your order. Unsaved
            drafts are not included.
          </p>
        </div>
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close preview
        </button>
      </div>
      <div className="preview-controls">
        <label className="field-label" htmlFor="preview-channel">
          Communication format
        </label>
        <select
          id="preview-channel"
          value={channel}
          onChange={(event) => setChannel(event.target.value as Channel)}
        >
          <option value="telegram-text">Telegram · text</option>
          <option value="telegram-voice">Telegram · voice note</option>
          <option value="desktop-voice">Desktop · voice</option>
        </select>
      </div>
      <p className="panel-padding muted">
        Only sections for the selected format are included. Dialogue examples apply to Telegram
        text. Time And Continuity applies to every conversation. Memory Use and Image Generation
        apply when their tools are available for the selected format. Reflection, heartbeat, and
        reminder prompts belong to their own jobs. Post-History Instructions stays after the
        conversation history.
      </p>
      {loading ? (
        <p className="panel-padding muted" role="status">
          Composing saved prompts…
        </p>
      ) : error ? (
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
      ) : (
        preview && (
          <>
            <textarea
              className="prompt-reading preview-content"
              aria-label="Composed prompt text"
              readOnly
              value={preview.content}
            />
            {preview.postHistoryContent && (
              <>
                <div className="panel-padding">
                  <h3>After the conversation history</h3>
                  <p className="muted">
                    These instructions are placed after the conversation history to guide Valerie’s
                    next reply.
                  </p>
                </div>
                <textarea
                  className="prompt-reading preview-content"
                  aria-label="Post-history character instructions"
                  readOnly
                  value={preview.postHistoryContent}
                />
              </>
            )}
            {preview.characterImportId && (
              <p className="panel-padding muted">
                Dialogue examples apply to Telegram text only. Template variables are shown as
                written; automatic variable expansion is not implemented yet.
              </p>
            )}
            <div className="preview-versions">
              <span className="muted">Included versions</span>
              {Object.entries(preview.versions).map(([id, version]) => (
                <Badge key={id}>
                  {id} · v{version}
                </Badge>
              ))}
            </div>
          </>
        )
      )}
    </section>
  );
}
