import type { AgreementOverview } from "@valerie/core";
import { useEffect, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import {
  habitOutcomeLabels,
  habitOutcomeTone,
  ruleConditionLabels,
} from "./agreement-presentation";

export function DailyAgreementSummary({
  api,
  visible,
  refreshKey,
  onOpen,
}: {
  api: Api;
  visible: boolean;
  refreshKey: number;
  onOpen: () => void;
}) {
  const [overview, setOverview] = useState<AgreementOverview | null>(null);
  const [error, setError] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Daily reports and explicit refreshes update this shared projection.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const value = await api<AgreementOverview>("/agreements", { signal: controller.signal });
        if (!controller.signal.aborted) {
          setOverview(value);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        pending = false;
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 30000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, visible, refreshKey]);
  if (error) return <ErrorNotice message={error} />;
  if (!overview || (!overview.habits.length && !overview.rules.length)) return null;
  const opportunities = overview.opportunities.filter(
    (opportunity) =>
      overview.habits.some(
        (habit) => habit.id === opportunity.habitId && habit.state === "active",
      ) && opportunity.applicable !== false,
  );
  const rules = overview.rules.filter((view) => view.applicable);
  return (
    <article className="panel dynamic-panel" aria-labelledby="daily-agreements-title">
      <div className="dynamic-heading">
        <h2 id="daily-agreements-title">Current habits and agreements</h2>
        <button type="button" className="text-button" onClick={onOpen}>
          Open Habits &amp; Rules
        </button>
      </div>
      {opportunities.length === 0 && rules.length === 0 ? (
        <p className="daily-empty">No habit opportunities or rule agreements currently apply.</p>
      ) : (
        <ul className="daily-progress-list">
          {opportunities.map((opportunity) => (
            <li key={opportunity.id}>
              <div className="dynamic-heading">
                <h3>{opportunity.definition.name}</h3>
                <Badge tone={habitOutcomeTone(opportunity.outcome)}>
                  {opportunity.outcome === "partial" && opportunity.definition.threshold !== null
                    ? "Below target"
                    : habitOutcomeLabels[opportunity.outcome]}
                </Badge>
              </div>
              <p>{opportunity.definition.fullPractice}</p>
            </li>
          ))}
          {rules.map((view) => (
            <li key={view.rule.id}>
              <div className="dynamic-heading">
                <h3>{view.rule.name}</h3>
                <Badge>{ruleConditionLabels[view.conditionResult]}</Badge>
              </div>
              <p>{view.rule.meaning}</p>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
