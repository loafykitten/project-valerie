import { useEffect, useMemo, useState } from "react";
import { ErrorNotice } from "../components/ui";
import { ActivityPage } from "../features/activity/ActivityPage";
import { ConversationPage } from "../features/conversation/ConversationPage";
import { DynamicDetailsPage } from "../features/dynamic/DynamicDetailsPage";
import { HeartbeatPage } from "../features/heartbeat/HeartbeatPage";
import { MemoryPage } from "../features/memory/MemoryPage";
import { PromptsPage } from "../features/prompts/PromptsPage";
import { SystemPage } from "../features/system/SystemPage";
import type { ServiceStatus } from "../features/system/types";
import { createApi, errorMessage } from "./api";

type Section =
  | "prompts"
  | "conversation"
  | "memory"
  | "dynamic"
  | "heartbeat"
  | "activity"
  | "system";
const sections: { id: Section; title: string; symbol: string }[] = [
  { id: "prompts", title: "Prompts", symbol: "✧" },
  { id: "conversation", title: "Conversation", symbol: "◌" },
  { id: "memory", title: "Memory", symbol: "◇" },
  { id: "dynamic", title: "Dynamic Details", symbol: "✳" },
  { id: "heartbeat", title: "Heartbeats", symbol: "♡" },
  { id: "activity", title: "Activity", symbol: "↗" },
  { id: "system", title: "System", symbol: "◈" },
];

export function App() {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [section, setSection] = useState<Section>("prompts");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [promptDrafts, setPromptDrafts] = useState(false);
  const [conversationDrafts, setConversationDrafts] = useState(false);
  const [memoryDrafts, setMemoryDrafts] = useState(false);
  const [heartbeatDrafts, setHeartbeatDrafts] = useState(false);
  const [dynamicDrafts, setDynamicDrafts] = useState(false);
  const api = useMemo(createApi, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The refresh counter explicitly requests a fresh service status.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<ServiceStatus>("/status", { signal: controller.signal })
      .then((result) => {
        setStatus(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, refresh]);

  const hasUnsavedDrafts =
    promptDrafts || conversationDrafts || memoryDrafts || heartbeatDrafts || dynamicDrafts;
  useEffect(() => {
    if (!hasUnsavedDrafts) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedDrafts]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <button
          type="button"
          className="brand"
          aria-label="Project Valerie home"
          onClick={() => setSection("prompts")}
        >
          <span className="brand-mark" aria-hidden="true">
            V<span>✧</span>
          </span>
          <span>
            <strong>Valerie</strong>
          </span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          {sections.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`nav-item ${section === item.id ? "is-active" : ""}`}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
            >
              <span className="nav-symbol" aria-hidden="true">
                {item.symbol}
              </span>
              {item.title}
              {section === item.id && <span className="nav-active-dot" aria-hidden="true" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span
            className={`status-dot ${status && !error ? "status-dot--success" : ""}`}
            aria-hidden="true"
          />
          <div>
            <strong>
              {status && !error
                ? "Dashboard online"
                : loading
                  ? "Connecting…"
                  : "Dashboard unavailable"}
            </strong>
          </div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>Project Valerie</span>
            <span aria-hidden="true">/</span>
            <strong>{sections.find((item) => item.id === section)?.title}</strong>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {error && (
            <div className="app-error">
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
          )}
          {!status && (
            <div className="initial-loading">
              <span className="loading-mark" aria-hidden="true">
                V<span>✧</span>
              </span>
              <h1>{loading ? "Loading dashboard…" : "Dashboard unavailable"}</h1>
              <p>
                {loading
                  ? "Checking Valerie’s service."
                  : "Check that Valerie’s service is running and open its private dashboard URL."}
              </p>
            </div>
          )}
          {status && (
            <>
              <div hidden={section !== "prompts"}>
                <PromptsPage api={api} onDirtyChange={setPromptDrafts} />
              </div>
              <div hidden={section !== "conversation"}>
                <ConversationPage api={api} onDirtyChange={setConversationDrafts} />
              </div>
              <div hidden={section !== "memory"}>
                <MemoryPage
                  api={api}
                  onDirtyChange={setMemoryDrafts}
                  visible={section === "memory"}
                />
              </div>
              <div hidden={section !== "heartbeat"}>
                <HeartbeatPage
                  api={api}
                  onDirtyChange={setHeartbeatDrafts}
                  visible={section === "heartbeat"}
                />
              </div>
              <div hidden={section !== "dynamic"}>
                <DynamicDetailsPage
                  api={api}
                  visible={section === "dynamic"}
                  onDirtyChange={setDynamicDrafts}
                />
              </div>
              {section === "activity" && <ActivityPage api={api} />}
              {section === "system" && (
                <SystemPage
                  status={status}
                  onRefresh={() => setRefresh((value) => value + 1)}
                  refreshing={loading}
                  available={!error}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
