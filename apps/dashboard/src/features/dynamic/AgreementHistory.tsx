import type { HabitDefinition, RuleDefinition } from "@valerie/core";
import { useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { dailyTime } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";

export function AgreementHistory({
  api,
  target,
  id,
  version,
}: {
  api: Api;
  target: "habits" | "rules";
  id: string;
  version: number;
}) {
  const [chosen, setChosen] = useState(Math.max(1, version - 1));
  const [record, setRecord] = useState<HabitDefinition | RuleDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <details className="agreement-advanced">
      <summary>Saved agreement versions</summary>
      <div className="dynamic-actions">
        <label className="dynamic-field">
          <span>Version to read</span>
          <input
            type="number"
            min={1}
            max={version}
            value={chosen}
            onChange={(event) => setChosen(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className="text-button"
          disabled={busy || !Number.isInteger(chosen) || chosen < 1 || chosen > version}
          onClick={() => {
            setBusy(true);
            setError("");
            void api<{ habit?: HabitDefinition; rule?: RuleDefinition }>(
              `/agreements/${target}/${encodeURIComponent(id)}?revision=${chosen}`,
            )
              .then((result) => setRecord(result.habit ?? result.rule ?? null))
              .catch((cause: unknown) => setError(errorMessage(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Reading…" : "Read saved agreement"}
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {record && (
        <div className="agreement-history-record">
          <p className="dynamic-field-hint">
            Saved version {record.version} · {record.state} · {dailyTime(record.updatedAt)}
          </p>
          <strong>{record.name}</strong>
          <p>{"fullPractice" in record ? record.fullPractice : record.meaning}</p>
          <p>{record.reason}</p>
          {"smallerPractice" in record && record.smallerPractice && (
            <p>Smaller version: {record.smallerPractice}</p>
          )}
          {"scope" in record && <p>Scope: {record.scope}</p>}
          <FocusSources api={api} sources={record.sources} />
        </div>
      )}
    </details>
  );
}
