import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";

type Edit = {
  id: string;
  text: string;
  status: string;
  failureCode: string | null;
  retryAfter: string | null;
};
type Message = { id: string; text: string; version: number; sequence: number; edit: Edit | null };
type Revision = { version: number; text: string; createdAt: string };
type Draft = { text: string; version: number; original: string; requestId: string };
export function MessageEditor({
  api,
  turnId,
  onDirtyChange,
  onClose,
  onApplied,
}: {
  api: Api;
  turnId: string;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
  onApplied: (text: string) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [histories, setHistories] = useState<Record<string, Revision[]>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = Object.values(drafts).some((d) => d.text !== d.original);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ messages: Message[] }>(
          `/conversation/turns/${turnId}/messages`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setMessages(result.messages);
        setDrafts((current) => {
          const next = { ...current };
          for (const message of result.messages) {
            const old = next[message.id];
            // Polling never erases an unsaved draft, even after another editor saves.
            if (!old || old.text === old.original)
              next[message.id] = {
                text: message.text,
                original: message.text,
                version: message.version,
                requestId: crypto.randomUUID(),
              };
          }
          return next;
        });
      } catch (e) {
        if (!controller.signal.aborted) setError(errorMessage(e));
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [api, turnId]);
  async function save(message: Message) {
    const draft = drafts[message.id];
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const { edit } = await api<{ edit: Edit }>(`/conversation/messages/${message.id}/edits`, {
        method: "POST",
        body: JSON.stringify({
          id: draft.requestId,
          text: draft.text,
          expectedVersion: draft.version,
        }),
      });
      setMessages((current) => current.map((m) => (m.id === message.id ? { ...m, edit } : m)));
      // The durable request now owns this draft; its status remains visible until confirmed.
      setDrafts((current) => ({
        ...current,
        [message.id]: {
          ...draft,
          text: message.text,
          original: message.text,
          version: message.version,
        },
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(edit: Edit) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ edit: Edit }>(`/conversation/edits/${edit.id}/retry`, {
        method: "POST",
      });
      setMessages((current) =>
        current.map((m) => (m.edit?.id === edit.id ? { ...m, edit: result.edit } : m)),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function history(message: Message, older = false) {
    setBusy(true);
    setError("");
    try {
      const before = older ? histories[message.id]?.at(-1)?.version : undefined;
      const result = await api<{ revisions: Revision[] }>(
        `/conversation/messages/${message.id}/revisions${before ? `?before=${before}` : ""}`,
      );
      setHistories((current) => ({
        ...current,
        [message.id]: older
          ? [...(current[message.id] ?? []), ...result.revisions]
          : result.revisions,
      }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const confirmedText = messages.map((m) => m.text).join("");
  useEffect(() => {
    if (confirmedText) onApplied(confirmedText);
  }, [confirmedText, onApplied]);
  return (
    <section className="message-editor" aria-label="Edit Valerie’s reply">
      <div className="conversation-turn-heading">
        <h3>Edit reply</h3>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={onClose}
        >
          {dirty ? "Discard draft and close" : "Close editor"}
        </button>
      </div>
      <p className="muted">
        Save updates the existing Telegram message and Valerie’s future history after Telegram
        confirms it. Earlier versions remain available here. A reply already in progress keeps its
        captured history.
      </p>
      {messages.length > 1 && (
        <p className="muted">
          This reply arrived as {messages.length} Telegram messages. Save each part separately.
          Parts join exactly as written, so keep any spacing between them.
        </p>
      )}
      {error && <ErrorNotice message={error} />}
      {!messages.length && <p className="muted">Loading delivered messages…</p>}
      {messages.map((message, index) => {
        const draft = drafts[message.id];
        const edit = message.edit;
        const locked = Boolean(edit && ["queued", "sending", "unknown"].includes(edit.status));
        return (
          <div key={message.id} className="message-editor-part">
            <label className="field-label" htmlFor={`reply-${message.id}`}>
              Message {index + 1} · version {message.version}
            </label>
            <textarea
              id={`reply-${message.id}`}
              rows={8}
              maxLength={4096}
              value={draft?.text ?? message.text}
              disabled={busy || locked}
              onChange={(e) =>
                setDrafts((current) => ({
                  ...current,
                  [message.id]: {
                    text: e.target.value,
                    original: draft?.original ?? message.text,
                    version: draft?.version ?? message.version,
                    requestId: crypto.randomUUID(),
                  },
                }))
              }
            />
            <p className="muted">
              {(draft?.text ?? message.text).length.toLocaleString()} / 4,096 characters
              {draft && draft.text !== draft.original ? " · Unsaved draft" : ""}
            </p>
            {draft && draft.version !== message.version && (
              <p role="alert">
                A newer version is saved. Your draft is retained. Reload before saving.
              </p>
            )}
            {edit && (
              <div role="status">
                <p>
                  {edit.status === "applied"
                    ? "Saved to Telegram and history."
                    : edit.status === "queued"
                      ? "Waiting for the Telegram worker…"
                      : edit.status === "sending"
                        ? "Updating Telegram…"
                        : edit.status === "unknown"
                          ? edit.failureCode === "confirmation_not_saved"
                            ? "Telegram accepted the change, but saving it to history failed. Retry the same edit to synchronize them."
                            : "Telegram’s edit result is uncertain. History still uses the last confirmed text. Retry the same edit to synchronize them."
                          : "Telegram did not accept the edit. History is unchanged."}
                </p>
                {edit.retryAfter && edit.status === "failed" && (
                  <p className="muted">Retry after {new Date(edit.retryAfter).toLocaleString()}.</p>
                )}
                {edit.status !== "applied" && (
                  <details>
                    <summary>Requested text</summary>
                    <p className="conversation-message">{edit.text}</p>
                  </details>
                )}
                {["failed", "unknown"].includes(edit.status) && (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() => void retry(edit)}
                  >
                    Retry this edit
                  </button>
                )}
                {edit.status === "failed" && (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={busy}
                    onClick={() =>
                      setDrafts((current) => ({
                        ...current,
                        [message.id]: {
                          text: edit.text,
                          original: message.text,
                          version: message.version,
                          requestId: crypto.randomUUID(),
                        },
                      }))
                    }
                  >
                    Revise requested text
                  </button>
                )}
              </div>
            )}
            <div className="conversation-actions">
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || locked}
                onClick={() => {
                  setDrafts((current) => ({
                    ...current,
                    [message.id]: {
                      text: message.text,
                      original: message.text,
                      version: message.version,
                      requestId: crypto.randomUUID(),
                    },
                  }));
                  setError("");
                }}
              >
                Reload saved text
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => void history(message)}
              >
                Revision history
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={
                  busy ||
                  locked ||
                  !draft?.text.trim() ||
                  draft.text === draft.original ||
                  draft.version !== message.version
                }
                onClick={() => void save(message)}
              >
                Save to Telegram and history
              </button>
            </div>
            {histories[message.id]?.map((revision) => (
              <details key={revision.version}>
                <summary>
                  Version {revision.version}
                  {revision.version === 1 ? " · original" : ""} ·{" "}
                  {new Date(revision.createdAt).toLocaleString()}
                </summary>
                <p className="conversation-message">{revision.text}</p>
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy || locked || revision.text === message.text}
                  onClick={() =>
                    setDrafts((current) => ({
                      ...current,
                      [message.id]: {
                        text: revision.text,
                        version: message.version,
                        original: message.text,
                        requestId: crypto.randomUUID(),
                      },
                    }))
                  }
                >
                  Use this version as draft
                </button>
              </details>
            ))}
            {(histories[message.id]?.at(-1)?.version ?? 1) > 1 && (
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={() => void history(message, true)}
              >
                Load older revisions
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}
