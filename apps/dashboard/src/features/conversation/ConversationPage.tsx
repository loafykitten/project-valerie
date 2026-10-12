import { useCallback, useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { ImagePrompt } from "./ImagePrompt";
import { MessageEditor } from "./MessageEditor";

type Model = {
  id: string;
  displayName: string;
  maxContextTokens: number;
  maxOutputTokens: number | null;
  vision: boolean;
  maxImages: number | null;
  reasoning: { supportedEfforts: string[] } | null;
};
type Settings = {
  version: number;
  model: string;
  contextTokens: number;
  historyTokens: number;
  historyHours: number;
  maxOutputTokens: number;
  temperature: number | null;
  reasoningEffort: string | null;
  capabilityCheckedAt: string | null;
  modelCapabilities?: Model | null;
};
type Turn = {
  id: string;
  status: string;
  receivedAt: string;
  inputText: string;
  outputText: string | null;
  failureCode: string | null;
  outputTruncated: boolean;
  historyTurns: number | null;
  canRetry: boolean;
  nextAttemptAt: string | null;
  attachments?: {
    id: string;
    status: string;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    failureCode: string | null;
  }[];
  generatedImages?: {
    id: string;
    status: string;
    assetId: string | null;
    failureCode: string | null;
    deliveredAt: string | null;
  }[];
};
type ConversationState = {
  settings: Settings;
  turns: Turn[];
  telegram: { state: string; lastError: string | null; lastUpdateAt: string | null };
  imageGeneration?: { configured: boolean; available: boolean };
};
function retainOlder(
  current: ConversationState | null,
  result: ConversationState,
): ConversationState {
  const ids = new Set(result.turns.map((turn) => turn.id));
  return {
    ...result,
    turns: [...result.turns, ...(current?.turns.filter((turn) => !ids.has(turn.id)) ?? [])],
  };
}

export function ConversationPage({
  api,
  onDirtyChange,
}: {
  api: Api;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [state, setState] = useState<ConversationState | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [editorTurn, setEditorTurn] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [olderAvailable, setOlderAvailable] = useState(true);
  const applyEditedReply = useCallback(
    (text: string) => {
      setState((current) =>
        current
          ? {
              ...current,
              turns: current.turns.map((turn) =>
                turn.id === editorTurn
                  ? {
                      ...turn,
                      outputText: text.slice(0, 16384),
                      outputTruncated: text.length > 16384,
                    }
                  : turn,
              ),
            }
          : current,
      );
    },
    [editorTurn],
  );
  const dirty = Boolean(draft && state && JSON.stringify(draft) !== JSON.stringify(state.settings));
  useEffect(() => {
    onDirtyChange(dirty || editorDirty);
  }, [dirty, editorDirty, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    api<ConversationState>("/conversation", { signal: controller.signal })
      .then((result) => {
        setState(result);
        setDraft(result.settings);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      void api<ConversationState>("/conversation", { signal: controller.signal })
        .then((result) => {
          setState((current) => retainOlder(current, result));
          if (!dirty) setDraft(result.settings);
        })
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [api, dirty]);

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const result = await api<ConversationState>("/conversation");
      setState((current) => retainOlder(current, result));
      if (!dirty) setDraft(result.settings);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ models: Model[] }>("/inference/models");
      setModels(result.models);
      setNotice("Available models and supported settings refreshed from Neuralwatt.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function reloadSaved() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<ConversationState>("/conversation");
      setState((current) => retainOlder(current, result));
      setDraft(result.settings);
      setNotice("Loaded the latest saved settings.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ settings: Settings }>("/inference/settings", {
        method: "PUT",
        body: JSON.stringify({
          model: draft.model,
          maxOutputTokens: draft.maxOutputTokens,
          contextTokens: draft.contextTokens,
          historyTokens: draft.historyTokens,
          historyHours: draft.historyHours,
          temperature: draft.temperature,
          reasoningEffort: draft.reasoningEffort,
          expectedVersion: draft.version,
        }),
      });
      setDraft(result.settings);
      setState((current) => (current ? { ...current, settings: result.settings } : current));
      setNotice("Settings saved. Valerie will use them on the next turn.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function retry(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/conversation/turns/${id}/retry`, { method: "POST" });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadOlder() {
    const before = state?.turns.at(-1)?.id;
    if (!before) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ turns: Turn[] }>(
        `/conversation/turns?before=${encodeURIComponent(before)}`,
      );
      setState((current) =>
        current
          ? {
              ...current,
              turns: [
                ...current.turns,
                ...result.turns.filter((turn) => !current.turns.some((old) => old.id === turn.id)),
              ],
            }
          : current,
      );
      setOlderAvailable(result.turns.length === 20);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function numberField(
    key: "contextTokens" | "historyTokens" | "historyHours" | "maxOutputTokens",
    label: string,
    detail: string,
  ) {
    return (
      <label className="conversation-field">
        <span className="field-label">{label}</span>
        <input
          disabled={busy}
          type="number"
          min="1"
          step="1"
          required
          value={draft?.[key] ?? ""}
          onChange={(event) =>
            setDraft((current) =>
              current ? { ...current, [key]: Number(event.target.value) } : current,
            )
          }
        />
        <span className="muted">{detail}</span>
      </label>
    );
  }
  const selectedModel =
    models.find((model) => model.id === draft?.model) ??
    (draft && draft.modelCapabilities?.id === draft.model ? draft.modelCapabilities : undefined);
  return (
    <section className="page" aria-labelledby="conversation-title">
      <div className="page-heading">
        <div>
          <h1 id="conversation-title">Conversation</h1>
          <p className="page-description">
            Neuralwatt settings, recent conversations, and Telegram delivery.
          </p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={busy}
          onClick={refresh}
        >
          Refresh status
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {notice && (
        <p className="conversation-notice" role="status">
          {notice}
        </p>
      )}
      {!state || !draft ? (
        <p className="muted">Loading conversation settings…</p>
      ) : (
        <>
          <div className="panel conversation-panel">
            <div className="panel-heading">
              <div>
                <h2>Telegram</h2>
                <p>
                  Reads your private text messages, photos, and image captions, then replies in her
                  own voice.
                </p>
              </div>
              <Badge tone={state.telegram.state === "running" ? "success" : "warning"}>
                {state.telegram.state}
              </Badge>
            </div>
            {state.telegram.lastError && (
              <p className="panel-padding">
                Last connection issue: {state.telegram.lastError.replaceAll("_", " ")}
              </p>
            )}
            <p className="panel-padding muted">
              {state.imageGeneration?.available
                ? "Ask Valerie for a selfie or a scene in Telegram. She will send the picture when it is ready."
                : state.imageGeneration?.configured
                  ? "Image generation is configured. A running Telegram connection and a model with verified tool support are required to use it."
                  : "Image generation is not configured."}
            </p>
            <p className="panel-padding muted">
              Send photos or JPEG, PNG, and WebP files up to 5 MiB each. Albums are collected into
              one reply, with up to ten images and 16 MiB total.
            </p>
            <p className="panel-padding muted">
              A delivery marked unknown will not be resent automatically. Reply edits update an
              existing message after Telegram confirms the change.
            </p>
          </div>
          <form
            className="panel conversation-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="panel-heading">
              <div>
                <h2>Inference</h2>
                <p>Each reply keeps one saved version of these settings and your prompts.</p>
              </div>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy}
                onClick={discover}
              >
                Refresh models
              </button>
            </div>
            <div className="conversation-fields">
              <label className="conversation-field">
                <span className="field-label">Model</span>
                <select
                  disabled={busy}
                  value={draft.model}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      model: event.target.value,
                      reasoningEffort: null,
                      temperature: null,
                    })
                  }
                >
                  {!models.some((model) => model.id === draft.model) && (
                    <option value={draft.model}>
                      {draft.model || "Choose a model after refreshing"}
                    </option>
                  )}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                      {model.vision ? " · images supported" : " · text only"}
                    </option>
                  ))}
                </select>
                <span className="muted">
                  {selectedModel?.vision
                    ? "Accepts images and text. "
                    : "Image input requires a model with verified vision support. "}
                  Model availability is checked again when you save.
                  {draft.model.endsWith("-flex") &&
                    " Flex uses spare capacity at a lower price. Replies may take up to five minutes. The served tier is shown in Dynamic Details → Context health → Recent diagnostics."}
                </span>
              </label>
              <label className="conversation-field">
                <span className="field-label">Reasoning effort</span>
                <select
                  disabled={busy}
                  value={draft.reasoningEffort ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, reasoningEffort: event.target.value || null })
                  }
                >
                  <option value="">Model default</option>
                  {draft.reasoningEffort &&
                    !selectedModel?.reasoning?.supportedEfforts.includes(draft.reasoningEffort) && (
                      <option value={draft.reasoningEffort}>{draft.reasoningEffort}</option>
                    )}
                  {selectedModel?.reasoning?.supportedEfforts.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort}
                    </option>
                  ))}
                </select>
                <span className="muted">
                  Only verified effort levels are offered after refreshing models.
                </span>
              </label>
              {numberField(
                "maxOutputTokens",
                "Reply token limit",
                "Includes any reasoning tokens used by the model.",
              )}
              {numberField(
                "contextTokens",
                "Total context limit",
                "Space for prompts, history, the current message, and the reply.",
              )}
            </div>
            <div className="panel-heading">
              <div>
                <h2>Message history</h2>
                <p>Keep the recent conversation together without daily chat resets.</p>
              </div>
            </div>
            <div className="conversation-fields">
              {numberField(
                "historyHours",
                "Recent history window (hours)",
                "48 hours keeps yesterday’s conversation available when space permits.",
              )}
              {numberField(
                "historyTokens",
                "History budget",
                "Conservative token allowance: one UTF-8 byte counts as one token, plus message overhead.",
              )}
            </div>
            <p className="panel-padding muted">
              Valerie includes the newest complete exchanges that fit both limits. Older messages
              stay archived and can be retrieved with conversation search. Long or very busy
              conversations can reach the budget before the time window ends. Up to four recent
              images can accompany the current images within the context budget. Older images remain
              archived; their captions and replies can stay in text history.
            </p>
            <div className="conversation-actions">
              <span className="muted">
                {dirty ? "Unsaved changes" : `Saved version ${draft.version}`}
              </span>
              {dirty && (
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy}
                  onClick={reloadSaved}
                >
                  Discard draft and reload saved
                </button>
              )}
              <button type="submit" className="button button--primary" disabled={busy || !dirty}>
                {busy ? "Working…" : "Save settings"}
              </button>
            </div>
          </form>
          <div className="panel conversation-panel">
            <div className="panel-heading">
              <div>
                <h2>Recent turns</h2>
                <p>
                  Stored messages and actual delivery outcomes. Edit a delivered reply to update
                  Telegram and future history.
                </p>
              </div>
            </div>
            {state.turns.length === 0 ? (
              <p className="panel-padding muted">
                No messages received yet. Message Valerie in Telegram to begin.
              </p>
            ) : (
              state.turns.map((turn) => (
                <article key={turn.id} className="conversation-turn">
                  <div className="conversation-turn-heading">
                    <time dateTime={turn.receivedAt}>
                      {new Date(turn.receivedAt).toLocaleString()}
                    </time>
                    <Badge
                      tone={
                        turn.status === "delivered"
                          ? "success"
                          : turn.status === "failed" || turn.status === "unknown"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {turn.status}
                    </Badge>
                  </div>
                  <p className="conversation-message conversation-message--owner">
                    <strong>You</strong>
                    {turn.inputText || (turn.attachments?.length ? "Image message" : "")}
                  </p>
                  {!!turn.attachments?.length && (
                    <div className="conversation-images">
                      {turn.attachments.map((attachment) => (
                        <figure key={attachment.id}>
                          {attachment.status === "ready" ? (
                            <a
                              href={`/api/conversation/attachments/${encodeURIComponent(attachment.id)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img
                                src={`/api/conversation/attachments/${encodeURIComponent(attachment.id)}`}
                                alt="Sent by you in Telegram"
                                loading="lazy"
                              />
                            </a>
                          ) : (
                            <p className="muted">
                              Image {attachment.status}
                              {attachment.failureCode
                                ? `: ${attachment.failureCode.replaceAll("_", " ")}`
                                : ""}
                            </p>
                          )}
                          {attachment.width && attachment.height && (
                            <figcaption>
                              {attachment.width} × {attachment.height}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                    </div>
                  )}
                  {turn.outputText && (
                    <p className="conversation-message conversation-message--reply">
                      <strong>
                        Valerie{turn.status !== "delivered" ? " · delivery unconfirmed" : ""}
                      </strong>
                      {turn.outputText}
                    </p>
                  )}
                  {turn.outputTruncated && (
                    <p className="muted">Reply preview shortened. The complete text is archived.</p>
                  )}
                  {turn.status === "delivered" && editorTurn !== turn.id && (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={editorTurn !== null}
                      onClick={() => setEditorTurn(turn.id)}
                    >
                      Edit reply
                    </button>
                  )}
                  {editorTurn === turn.id && (
                    <MessageEditor
                      api={api}
                      turnId={turn.id}
                      onDirtyChange={setEditorDirty}
                      onApplied={applyEditedReply}
                      onClose={() => {
                        setEditorTurn(null);
                        setEditorDirty(false);
                      }}
                    />
                  )}
                  {!!turn.generatedImages?.length && (
                    <div className="conversation-images">
                      {turn.generatedImages.map((job) => (
                        <figure key={job.id}>
                          {job.assetId && (
                            <a
                              href={`/api/conversation/generated-images/${encodeURIComponent(job.assetId)}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img
                                src={`/api/conversation/generated-images/${encodeURIComponent(job.assetId)}`}
                                alt="Generated by Valerie for this request"
                                loading="lazy"
                              />
                            </a>
                          )}
                          <figcaption>
                            {job.status === "sent"
                              ? "Photo delivered in Telegram"
                              : job.status === "ready"
                                ? "Image ready · waiting for Telegram delivery"
                                : job.status === "failed"
                                  ? "Image request failed"
                                  : job.status === "unknown"
                                    ? "Image outcome unconfirmed · no automatic resend"
                                    : job.status === "recovery"
                                      ? "Checking image request status"
                                      : job.status === "sending"
                                        ? "Sending image to Telegram"
                                        : "Generating image…"}
                            {job.failureCode ? ` · ${job.failureCode.replaceAll("_", " ")}` : ""}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                  {turn.generatedImages?.map((job) => (
                    <ImagePrompt key={job.id} api={api} jobId={job.id} />
                  ))}
                  {turn.historyTurns !== null && (
                    <p className="muted">
                      {turn.historyTurns} prior exchanges included in this reply.
                    </p>
                  )}
                  {turn.failureCode && (
                    <p className="muted">{turn.failureCode.replaceAll("_", " ")}</p>
                  )}
                  {turn.nextAttemptAt && (
                    <p className="muted">
                      Retry scheduled for {new Date(turn.nextAttemptAt).toLocaleString()}. Later
                      replies wait to preserve conversation order.
                    </p>
                  )}
                  {turn.canRetry && (
                    <>
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={busy}
                        onClick={() => retry(turn.id)}
                      >
                        Retry original turn
                      </button>
                      <p className="muted">
                        Uses its original settings. After changing settings, send a new message
                        instead.
                      </p>
                    </>
                  )}
                </article>
              ))
            )}
            {!!state.turns.length && olderAvailable && (
              <div className="conversation-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  disabled={busy}
                  onClick={() => void loadOlder()}
                >
                  Load older turns
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
