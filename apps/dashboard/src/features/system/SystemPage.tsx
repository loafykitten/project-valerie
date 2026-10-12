import { Badge } from "../../components/ui";
import type { ServiceStatus } from "./types";

export function SystemPage({
  status,
  onRefresh,
  refreshing,
  available,
}: {
  status: ServiceStatus;
  onRefresh: () => void;
  refreshing: boolean;
  available: boolean;
}) {
  return (
    <section className="page" aria-labelledby="system-title">
      <div className="page-heading">
        <div>
          <h1 id="system-title">System</h1>
          <p className="page-description">Where Valerie runs and which features are available.</p>
        </div>
        <button
          type="button"
          className="button button--secondary"
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh status"}
        </button>
      </div>
      <div className="system-summary">
        <div className="panel summary-card">
          <span className="eyebrow">Running on</span>
          <h2>{status.runtime.hostname}</h2>
          <Badge tone={available ? "success" : "warning"}>
            {available ? "Dashboard online" : "Last known host"}
          </Badge>
        </div>
        <div className="panel summary-card">
          <span className="eyebrow">Available now</span>
          <h2>Text and images</h2>
          <p>
            Saved prompts, memory, Neuralwatt conversation, ComfyUI images, Telegram delivery, and
            an activity log.
          </p>
        </div>
        <div className="panel summary-card">
          <span className="eyebrow">Character source</span>
          <h2>{status.characterImported ? "Imported" : "Not imported"}</h2>
          <p>
            {status.characterImported
              ? "Original character data and wording are preserved."
              : "Personality and relationship text remain empty until a card is imported."}
          </p>
        </div>
      </div>
      <div className="panel integrations-panel">
        <div className="panel-heading">
          <div>
            <h2>Integrations</h2>
            <p>
              These indicators check saved configuration only. They do not test provider
              connections.
            </p>
          </div>
        </div>
        <div className="integration-list">
          {status.integrations.map((integration) => (
            <div className="integration-row" key={integration.name}>
              <div>
                <h3>{integration.name}</h3>
                <p>
                  {integration.implemented
                    ? integration.configured
                      ? "Configuration is present."
                      : "Configuration is missing."
                    : integration.configured
                      ? "Not built yet. Configuration is present."
                      : "Not built yet. Configuration is missing."}
                </p>
              </div>
              <Badge
                tone={integration.implemented && !integration.configured ? "warning" : "neutral"}
              >
                {integration.implemented
                  ? integration.configured
                    ? "Configured"
                    : "Not configured"
                  : "Not built yet"}
              </Badge>
            </div>
          ))}
        </div>
        {status.integrations.length === 0 && (
          <p className="panel-padding muted">No integrations are available.</p>
        )}
      </div>
      <div className="notice">
        <span className="notice-symbol" aria-hidden="true">
          ↗
        </span>
        <div>
          <h3>Not available yet</h3>
          <p>Reminders, voice, system watching, and the macOS companion are not built yet.</p>
        </div>
      </div>
    </section>
  );
}
