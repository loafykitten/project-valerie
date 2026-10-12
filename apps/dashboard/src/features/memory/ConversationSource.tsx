import type { ConversationEvidence } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { formattedTime } from "../../components/ui";

export function ConversationSource({ api, id }: { api: Api; id: string }) {
  const [record, setRecord] = useState<ConversationEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const read = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await api<ConversationEvidence>(
        `/memory/conversations/${encodeURIComponent(id)}?offset=${record?.nextOffset ?? 0}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setRecord((previous) => ({ ...next, text: (previous?.text ?? "") + next.text }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div className="memory-conversation-source">
      {record && (
        <>
          <p className="muted">
            {record.role === "user" ? "You" : "Valerie"} · {formattedTime(record.observedAt)}
          </p>
          <blockquote>
            {record.text || "This message has no text; its original media remains in Conversation."}
          </blockquote>
        </>
      )}
      {(!record || record.nextOffset !== null) && (
        <button type="button" className="text-button" disabled={busy} onClick={() => void read()}>
          {busy ? "Reading…" : record ? "Read more of the message" : "Read original message"}
        </button>
      )}
      {error && (
        <p role="alert" className="muted">
          {error}
        </p>
      )}
    </div>
  );
}
