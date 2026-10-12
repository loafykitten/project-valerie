import type { ContextHealthReport, ContextSignal } from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice, formattedTime } from "../../components/ui";

const signalLabels: Record<ContextSignal, string> = {
  history_size_budget: "Recent history was shortened to fit",
  fixed_context_budget: "Required context did not fit",
  core_memory_budget: "Core memory did not fit",
  tool_context_budget: "A tool continuation did not fit",
  provider_context_refusal: "The provider rejected the context size",
  output_budget_exhausted: "The response budget was exhausted",
};

function count(value: number | null) {
  return value === null ? "Unavailable" : value.toLocaleString();
}

export function ContextHealthPanel({ api, visible }: { api: Api; visible: boolean }) {
  const [report, setReport] = useState<ContextHealthReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  async function retryNotice(notice: ContextHealthReport["notices"][number]) {
    setRetrying(notice.id);
    setError("");
    try {
      await api(`/context-health/notices/${encodeURIComponent(notice.id)}/retry`, {
        method: "POST",
        body: JSON.stringify({ expectedAttempts: notice.attempts }),
      });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRetrying(null);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh requests the latest bounded diagnostics.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<ContextHealthReport>("/context-health", { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setReport(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, visible, refresh]);

  const pressure = (report?.summary.pressureSources ?? 0) > 0;
  const output = (report?.summary.outputExhaustedSources ?? 0) > 0;
  const title =
    !report || report.summary.sources === 0
      ? "Awaiting conversation data"
      : pressure
        ? "Context pressure recorded"
        : output
          ? "Response limit reached"
          : "No context pressure recorded";
  return (
    <article
      className="panel dynamic-panel dynamic-context"
      aria-labelledby="dynamic-context-title"
    >
      <div className="dynamic-heading">
        <div>
          <h2 id="dynamic-context-title">Context health</h2>
          <p className="dynamic-intro">Keep an eye on how much Valerie has to work with.</p>
        </div>
        {report && (
          <Badge tone={pressure || output || error ? "warning" : "neutral"}>
            {error ? "Last known status" : title}
          </Badge>
        )}
      </div>
      {error && <ErrorNotice message={error} />}
      {!report ? (
        <p className="muted">
          {loading ? "Loading context health…" : "Context health is unavailable."}
        </p>
      ) : (
        <>
          <dl className="dynamic-context-counts">
            <div>
              <dt>Largest request input</dt>
              <dd>
                {count(report.summary.largestInputTokens)} <small>tokens</small>
              </dd>
            </div>
            <div>
              <dt>Requests inspected</dt>
              <dd>{count(report.summary.requests)}</dd>
            </div>
            <div>
              <dt>Context pressure</dt>
              <dd>
                {count(report.summary.pressureSources)} <small>conversations or heartbeats</small>
              </dd>
            </div>
            <div>
              <dt>Response limit reached</dt>
              <dd>
                {count(report.summary.outputExhaustedSources)}{" "}
                <small>conversations or heartbeats</small>
              </dd>
            </div>
          </dl>
          <p className="dynamic-field-hint">
            There is no calibrated quality threshold yet. These checks use actual context limits and
            response limits; they do not measure how well Valerie is thinking.
          </p>
          <p className="dynamic-field-hint">
            {report.notificationDelivery === "enabled"
              ? "Telegram notices are enabled for new context pressure or exhausted response budgets. They do not use the heartbeat allowance."
              : report.notificationDelivery === "disabled"
                ? "Telegram notices are currently off. Diagnostics are available here."
                : "Telegram notices are not active yet. Diagnostics are available here."}
          </p>
          <details className="dynamic-context-details">
            <summary>Warning delivery</summary>
            {(report.notices ?? []).length === 0 ? (
              <p className="muted">No context warnings have been queued.</p>
            ) : (
              <ol className="dynamic-context-sources">
                {report.notices.map((notice) => (
                  <li key={notice.id}>
                    <div className="dynamic-note-heading">
                      <strong>
                        {notice.category === "context"
                          ? "Context warning"
                          : "Response-limit warning"}
                      </strong>
                      <time dateTime={notice.createdAt}>{formattedTime(notice.createdAt)}</time>
                    </div>
                    <p>
                      {notice.status === "sent"
                        ? "Telegram confirmed delivery."
                        : notice.status === "unknown"
                          ? "Delivery could not be confirmed. This warning will not be resent automatically."
                          : notice.status === "failed"
                            ? "This warning could not be sent."
                            : notice.status === "cancelled"
                              ? "The condition cleared before this warning was sent."
                              : notice.status === "sending"
                                ? "Sending."
                                : notice.status === "retry"
                                  ? "Waiting to retry delivery."
                                  : "Queued for delivery."}
                    </p>
                    {notice.status === "failed" && notice.active && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={retrying !== null || loading}
                        onClick={() => void retryNotice(notice)}
                      >
                        {retrying === notice.id ? "Queueing…" : "Retry warning"}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </details>
          <details className="dynamic-context-details">
            <summary>Recent diagnostics</summary>
            <p className="dynamic-field-hint">
              A turn can make several requests. Its combined usage is different from the largest
              individual request. The download includes measurements and references without
              conversation text.
            </p>
            {report.sources.length === 0 ? (
              <p className="muted">No recent requests to inspect.</p>
            ) : (
              <ol className="dynamic-context-sources">
                {report.sources.map((source) => (
                  <li key={`${source.kind}:${source.id}`}>
                    <div className="dynamic-note-heading">
                      <strong>{source.kind === "heartbeat" ? "Heartbeat" : "Conversation"}</strong>
                      <time dateTime={source.occurredAt}>{formattedTime(source.occurredAt)}</time>
                    </div>
                    <p>
                      {source.model ?? "Model unavailable"} · largest input{" "}
                      {count(source.peakInputTokens)} · combined input{" "}
                      {count(source.cumulativeUsage.inputTokens)}
                    </p>
                    {source.signals.length > 0 && (
                      <ul>
                        {source.signals.map((signal) => (
                          <li key={signal}>{signalLabels[signal]}</li>
                        ))}
                      </ul>
                    )}
                    {source.requests.length > 0 && (
                      <ul>
                        {source.requests.map((request, index) => (
                          <li key={request.id}>
                            Request {index + 1}:{" "}
                            {request.serviceTier === "flex"
                              ? "Flex confirmed"
                              : request.serviceTier === "standard"
                                ? "Standard tier"
                                : "Tier unknown"}
                            {source.model?.endsWith("-flex") && request.serviceTier === "standard"
                              ? " — Flex was requested but was not applied."
                              : ""}
                            {request.costUsd != null
                              ? ` · reported cost $${request.costUsd.toFixed(6)}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="dynamic-context-reference">Reference: {source.id}</p>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
      <div className="dynamic-actions dynamic-save">
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {loading ? "Refreshing…" : "Refresh context health"}
        </button>
        {report && (
          <a className="text-button" href="/api/context-health/export" download>
            Download diagnostics
          </a>
        )}
        {report && (
          <span className="muted dynamic-prompt-time">
            Updated {formattedTime(report.generatedAt)}
          </span>
        )}
      </div>
    </article>
  );
}
