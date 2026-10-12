import type {
  AgreementOverview,
  AgreementState,
  DailyOverview,
  HabitDefinition,
  HabitOpportunity,
  RuleDefinition,
  RuleView,
} from "@valerie/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { Badge, ErrorNotice } from "../../components/ui";
import { AgreementHistory } from "./AgreementHistory";
import { AgreementPermissionsPanel } from "./AgreementPermissionsPanel";
import {
  habitCadenceLabel,
  habitOutcomeLabels,
  habitOutcomeTone,
  ruleConditionLabels,
  rulePhaseLabels,
} from "./agreement-presentation";
import { dailyTime, progressStatusLabels } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";
import { HabitEditor } from "./HabitEditor";
import { HabitMetricsPanel } from "./HabitMetricsPanel";
import { HabitVariantEditor } from "./HabitVariantEditor";
import { RuleEditor } from "./RuleEditor";
import { RuleNotesPanel } from "./RuleNotesPanel";
import "./agreements.css";

type EditorState =
  | { target: "habit"; record: HabitDefinition | null }
  | { target: "rule"; record: RuleDefinition | null }
  | { target: "variant"; opportunity: HabitOpportunity }
  | { target: "note"; rule: RuleDefinition };
export function AgreementsPage({
  api,
  visible,
  refreshKey,
  onDirtyChange,
  onOpenDaily,
  onOpenReminders,
}: {
  api: Api;
  visible: boolean;
  refreshKey: number;
  onDirtyChange: (dirty: boolean) => void;
  onOpenDaily: () => void;
  onOpenReminders: () => void;
}) {
  const [overview, setOverview] = useState<AgreementOverview | null>(null);
  const [daily, setDaily] = useState<DailyOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [latest, setLatest] = useState<HabitDefinition | RuleDefinition | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [permissionDirty, setPermissionDirty] = useState(false);
  const writing = useRef(false);
  const requestRefresh = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(
    () => onDirtyChange(editorDirty || editorBusy || permissionDirty || busy),
    [editorDirty, editorBusy, permissionDirty, busy, onDirtyChange],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Refreshes preserve editors while loading the actual current rules, opportunities and shared subjects.
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending || writing.current) return;
      pending = true;
      setLoading(true);
      try {
        const results = await Promise.all([
          api<AgreementOverview>("/agreements", { signal: controller.signal }),
          api<DailyOverview>("/dynamic/daily", { signal: controller.signal }),
        ]);
        if (!controller.signal.aborted) {
          setOverview(results[0]);
          setDaily(results[1]);
          setError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [api, visible, refresh, refreshKey]);
  const editId =
    editor && (editor.target === "habit" || editor.target === "rule") ? editor.record?.id : null;
  const editTarget = editor?.target;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Fetch a selected definition even if it is outside the recent overview.
  useEffect(() => {
    if (!editId || (editTarget !== "habit" && editTarget !== "rule")) {
      setLatest(null);
      return;
    }
    const controller = new AbortController();
    api<{ habit?: HabitDefinition; rule?: RuleDefinition }>(
      `/agreements/${editTarget === "habit" ? "habits" : "rules"}/${encodeURIComponent(editId)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setLatest(result.habit ?? result.rule ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setActionError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [api, editId, editTarget, refresh, refreshKey]);
  function open(next: EditorState) {
    if (editorBusy || busy) return;
    if (
      editorDirty &&
      !window.confirm("Discard the unsaved agreement changes before opening another?")
    )
      return;
    setEditor(next);
    setLatest(next.target === "habit" || next.target === "rule" ? next.record : null);
    setActionError("");
    setNotice("");
  }
  async function setState(
    target: "habit" | "rule",
    record: HabitDefinition | RuleDefinition,
    state: AgreementState,
  ) {
    if (writing.current || editorBusy) return;
    writing.current = true;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      await api(
        `/agreements/${target === "habit" ? "habits" : "rules"}/${encodeURIComponent(record.id)}/state`,
        { method: "POST", body: JSON.stringify({ expectedVersion: record.version, state }) },
      );
      setNotice(
        `${record.name}: ${state === "active" ? "resumed" : state === "paused" ? "paused" : "archived"}.`,
      );
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      requestRefresh();
    }
  }
  function saved(record: HabitDefinition | RuleDefinition) {
    setNotice(`${record.name} saved. Existing reports and agreement versions are kept.`);
  }
  const lock = busy || editorBusy;
  const timezone = daily?.currentDay?.wakeTime.timezone ?? "America/Chicago";
  function habitCard(habit: HabitDefinition) {
    const opportunity = overview?.opportunities.find((item) => item.habitId === habit.id);
    const behavior = daily?.behaviors.find((item) => item.id === habit.behaviorId);
    const outcome = opportunity?.outcome;
    return (
      <li className="agreement-card" key={habit.id}>
        <div className="dynamic-heading">
          <h3>{habit.name}</h3>
          <Badge>
            {habit.state === "active" ? "Active" : habit.state === "paused" ? "Paused" : "Archived"}
          </Badge>
        </div>
        <p className="dynamic-intro">{habit.reason}</p>
        <p className="agreement-practice">{habit.fullPractice}</p>
        {habit.smallerPractice && (
          <p className="dynamic-field-hint">Smaller version: {habit.smallerPractice}</p>
        )}
        <dl className="agreement-facts">
          <div>
            <dt>Cadence</dt>
            <dd>{habitCadenceLabel(habit.cadence)}</dd>
          </div>
          <div>
            <dt>Begins</dt>
            <dd>{dailyTime(habit.effectiveAt, timezone)}</dd>
          </div>
          <div>
            <dt>Shared subject</dt>
            <dd>
              {behavior?.name ?? "Saved tracking subject"}
              {habit.threshold !== null
                ? ` · ${habit.threshold} ${behavior?.unit ?? "units"} or more`
                : ""}
            </dd>
          </div>
          <div>
            <dt>Check-in slots</dt>
            <dd>
              {habit.slots.map((slot) => (slot === "morning" ? "Morning" : "Evening")).join(", ")}
            </dd>
          </div>
        </dl>
        {opportunity && outcome && (
          <div className="agreement-today">
            <div className="dynamic-heading">
              <strong>This waking day</strong>
              <Badge tone={habitOutcomeTone(outcome)}>
                {outcome === "partial" && opportunity.definition.threshold !== null
                  ? "Below target"
                  : habitOutcomeLabels[outcome]}
              </Badge>
            </div>
            {opportunity.progress.value !== null && (
              <p className="dynamic-field-hint">
                Reported {opportunity.progress.value} {behavior?.unit ?? "units"}
                {opportunity.definition.threshold !== null
                  ? ` · full practice ${opportunity.definition.threshold}`
                  : ""}
                .
              </p>
            )}
            {opportunity.definitionVersion !== habit.version && (
              <p className="dynamic-field-hint">
                This day uses saved practice version {opportunity.definitionVersion}. Existing
                opportunities keep their original meaning.
              </p>
            )}
            {opportunity.applicable && habit.state !== "archived" && (
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() => open({ target: "variant", opportunity })}
              >
                Link a reported practice version
              </button>
            )}
          </div>
        )}
        {!opportunity && (
          <p className="dynamic-field-hint">
            No current opportunity has been established for this habit.
          </p>
        )}
        <details className="agreement-advanced">
          <summary>Agreement sources and versions</summary>
          <FocusSources api={api} sources={habit.sources} />
          <FocusSources api={api} sources={habit.stateSources} label="Status context" />
          <AgreementHistory api={api} target="habits" id={habit.id} version={habit.version} />
        </details>
        {habit.state !== "archived" && (
          <div className="dynamic-actions dynamic-save">
            <button
              type="button"
              className="text-button"
              disabled={lock}
              onClick={() => open({ target: "habit", record: habit })}
            >
              Edit habit
            </button>
            <button
              type="button"
              className="text-button"
              disabled={lock}
              onClick={() =>
                void setState("habit", habit, habit.state === "paused" ? "active" : "paused")
              }
            >
              {habit.state === "paused" ? "Resume habit" : "Pause habit"}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={lock}
              onClick={() => void setState("habit", habit, "archived")}
            >
              Archive habit
            </button>
          </div>
        )}
      </li>
    );
  }
  function ruleCard(view: RuleView) {
    const rule = view.rule;
    const condition = rule.condition;
    const behavior = condition
      ? daily?.behaviors.find((item) => item.id === condition.behaviorId)
      : null;
    return (
      <li className="agreement-card" key={rule.id}>
        <div className="dynamic-heading">
          <h3>{rule.name}</h3>
          <Badge tone={view.applicable ? "accent" : "neutral"}>{rulePhaseLabels[view.phase]}</Badge>
        </div>
        <p className="agreement-practice">{rule.meaning}</p>
        <p className="dynamic-intro">{rule.reason}</p>
        <p className="dynamic-field-hint">Scope: {rule.scope}</p>
        <dl className="agreement-facts">
          <div>
            <dt>Begins</dt>
            <dd>{dailyTime(rule.effectiveAt, rule.timezone)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{rule.expiresAt ? dailyTime(rule.expiresAt, rule.timezone) : "No expiry"}</dd>
          </div>
          {rule.window && (
            <div>
              <dt>Agreed hours</dt>
              <dd>
                {rule.window.start}–{rule.window.end} · {rule.timezone}
              </dd>
            </div>
          )}
        </dl>
        {rule.exceptions.length > 0 && (
          <div className="agreement-exceptions">
            <h4>Agreed exceptions</h4>
            <ul>
              {rule.exceptions.map((exception, index) => (
                <li key={index.toString()}>{exception}</li>
              ))}
            </ul>
          </div>
        )}
        {condition && (
          <div className="agreement-today">
            <strong>{behavior?.name ?? "Shared reported condition"}</strong>
            <p className="dynamic-field-hint">
              {condition.comparison === "status_is"
                ? progressStatusLabels[condition.status]
                : `${condition.comparison === "at_least" ? "At least" : condition.comparison === "at_most" ? "At most" : "Exactly"} ${condition.value} ${behavior?.unit ?? "units"}`}
            </p>
            <Badge tone={view.conditionResult === "uncertain" ? "warning" : "neutral"}>
              {ruleConditionLabels[view.conditionResult]}
            </Badge>
            {view.progress?.value !== null && view.progress?.value !== undefined && (
              <p className="dynamic-field-hint">Reported value: {view.progress.value}.</p>
            )}
            <p className="dynamic-field-hint">
              The reported condition is evidence to discuss, not an automatic violation score.
            </p>
          </div>
        )}
        <details className="agreement-advanced">
          <summary>Agreement sources and versions</summary>
          <FocusSources api={api} sources={rule.sources} />
          <FocusSources api={api} sources={rule.stateSources} label="Status context" />
          <AgreementHistory api={api} target="rules" id={rule.id} version={rule.version} />
        </details>
        <div className="dynamic-actions dynamic-save">
          <button
            type="button"
            className="text-button"
            disabled={lock}
            onClick={() => open({ target: "note", rule })}
          >
            Discussion and context
          </button>
          {rule.state !== "archived" && (
            <>
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() => open({ target: "rule", record: rule })}
              >
                Edit rule
              </button>
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() =>
                  void setState("rule", rule, rule.state === "paused" ? "active" : "paused")
                }
              >
                {rule.state === "paused" ? "Resume rule" : "Pause rule"}
              </button>
              <button
                type="button"
                className="text-button"
                disabled={lock}
                onClick={() => void setState("rule", rule, "archived")}
              >
                Archive rule
              </button>
            </>
          )}
        </div>
      </li>
    );
  }
  return (
    <section className="agreements-page" aria-labelledby="agreements-title">
      <div className="dynamic-heading">
        <div>
          <h2 id="agreements-title">Habits &amp; Rules</h2>
          <p className="dynamic-intro">
            Agreed practices and boundaries, supported by the same source-backed daily records.
          </p>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={loading || lock}
          onClick={requestRefresh}
        >
          {loading ? "Refreshing…" : "Refresh agreements"}
        </button>
      </div>
      {error && <ErrorNotice message={error} />}
      {actionError && <ErrorNotice message={actionError} />}
      {notice && (
        <p className="notice dynamic-feedback" role="status">
          {notice}
        </p>
      )}
      {!overview || !daily ? (
        <div className="panel dynamic-panel">
          <p className="muted">
            {loading ? "Loading habits and rules…" : "Agreements are unavailable."}
          </p>
        </div>
      ) : (
        <>
          {editor?.target === "habit" && (
            <HabitEditor
              key={`habit:${editor.record?.id ?? "new"}`}
              api={api}
              habit={editor.record}
              latest={latest as HabitDefinition | null}
              behaviors={daily.behaviors}
              timezone={timezone}
              onSaved={saved}
              onRefresh={requestRefresh}
              onClose={() => setEditor(null)}
              onOpenDaily={onOpenDaily}
              onDirtyChange={setEditorDirty}
              onBusyChange={setEditorBusy}
            />
          )}
          {editor?.target === "rule" && (
            <RuleEditor
              key={`rule:${editor.record?.id ?? "new"}`}
              api={api}
              rule={editor.record}
              latest={latest as RuleDefinition | null}
              behaviors={daily.behaviors}
              onSaved={saved}
              onRefresh={requestRefresh}
              onClose={() => setEditor(null)}
              onDirtyChange={setEditorDirty}
              onBusyChange={setEditorBusy}
            />
          )}
          {editor?.target === "variant" && (
            <HabitVariantEditor
              key={`variant:${editor.opportunity.id}`}
              api={api}
              opportunity={editor.opportunity}
              onRefresh={requestRefresh}
              onClose={() => setEditor(null)}
              onDirtyChange={setEditorDirty}
              onBusyChange={setEditorBusy}
            />
          )}
          {editor?.target === "note" && (
            <RuleNotesPanel
              key={`note:${editor.rule.id}`}
              api={api}
              rule={editor.rule}
              days={daily.days}
              currentDayId={daily.currentDay?.id ?? null}
              onClose={() => setEditor(null)}
              onDirtyChange={setEditorDirty}
              onBusyChange={setEditorBusy}
            />
          )}
          <div className="dynamic-columns">
            <div className="agreement-main">
              <article className="panel dynamic-panel">
                <div className="dynamic-heading">
                  <h2>Habits</h2>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={lock}
                    onClick={() => open({ target: "habit", record: null })}
                  >
                    New habit
                  </button>
                </div>
                {overview.habits.filter((habit) => habit.state !== "archived").length === 0 ? (
                  <p className="daily-empty">
                    No current habits. Choose practices together when they would help.
                  </p>
                ) : (
                  <ul className="agreement-list">
                    {overview.habits.filter((habit) => habit.state !== "archived").map(habitCard)}
                  </ul>
                )}
                {overview.habits.some((habit) => habit.state === "archived") && (
                  <details className="agreement-advanced">
                    <summary>Archived habits</summary>
                    <ul className="agreement-list">
                      {overview.habits.filter((habit) => habit.state === "archived").map(habitCard)}
                    </ul>
                  </details>
                )}
              </article>
              <article className="panel dynamic-panel">
                <div className="dynamic-heading">
                  <h2>Rules</h2>
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={lock}
                    onClick={() => open({ target: "rule", record: null })}
                  >
                    New rule
                  </button>
                </div>
                <p className="dynamic-intro">
                  Honest feelings, agreed exceptions and uncertainty stay welcome. Rules follow
                  their saved scope and expiry.
                </p>
                {overview.rules.filter((view) => view.rule.state !== "archived").length === 0 ? (
                  <p className="daily-empty">
                    No current rule agreements. Planning examples have not been activated.
                  </p>
                ) : (
                  <ul className="agreement-list">
                    {overview.rules.filter((view) => view.rule.state !== "archived").map(ruleCard)}
                  </ul>
                )}
                {overview.rules.some((view) => view.rule.state === "archived") && (
                  <details className="agreement-advanced">
                    <summary>Archived rules</summary>
                    <ul className="agreement-list">
                      {overview.rules
                        .filter((view) => view.rule.state === "archived")
                        .map(ruleCard)}
                    </ul>
                  </details>
                )}
              </article>
            </div>
            <div className="dynamic-sidebar">
              <AgreementPermissionsPanel
                api={api}
                settings={overview.settings}
                onRefresh={requestRefresh}
                onDirtyChange={setPermissionDirty}
              />
              <article className="panel dynamic-panel">
                <h2>Check-in timing</h2>
                <p className="dynamic-intro">
                  Choose morning and evening pacing separately from the practices and targets agreed
                  here.
                </p>
                <button type="button" className="text-button" onClick={onOpenReminders}>
                  Open coordinated check-in settings
                </button>
                <button
                  type="button"
                  className="text-button agreement-block-link"
                  onClick={onOpenDaily}
                >
                  Read or correct shared daily reports
                </button>
              </article>
            </div>
          </div>
          <HabitMetricsPanel api={api} visible={visible} refreshKey={refresh + refreshKey} />
        </>
      )}
    </section>
  );
}
