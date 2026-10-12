import type {
  ProgressBehavior,
  ProgressStatus,
  RuleCondition,
  RuleDefinition,
  RuleSaveInput,
} from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { AgreementWeekdays } from "./AgreementWeekdays";
import {
  DailyTimeField,
  newTimeDraft,
  resolveTimeDraft,
  timeDraftFromReported,
} from "./DailyTimeField";
import { dailyTime, progressStatusLabels } from "./daily-presentation";
import { ToggleOption } from "./ToggleOption";

export function RuleEditor({
  api,
  rule,
  latest,
  behaviors,
  onSaved,
  onRefresh,
  onClose,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  rule: RuleDefinition | null;
  latest: RuleDefinition | null;
  behaviors: ProgressBehavior[];
  onSaved: (rule: RuleDefinition) => void;
  onRefresh: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const initialStart = useRef(
    rule
      ? timeDraftFromReported({ at: rule.effectiveAt, timezone: rule.timezone, basis: "exact" })
      : newTimeDraft("America/Chicago"),
  );
  const initialExpiry = useRef(
    rule?.expiresAt
      ? timeDraftFromReported({ at: rule.expiresAt, timezone: rule.timezone, basis: "exact" })
      : newTimeDraft(rule?.timezone ?? "America/Chicago", "unknown"),
  );
  const [name, setName] = useState(rule?.name ?? "");
  const [meaning, setMeaning] = useState(rule?.meaning ?? "");
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [scope, setScope] = useState(rule?.scope ?? "");
  const [start, setStart] = useState(initialStart.current);
  const [expiry, setExpiry] = useState(initialExpiry.current);
  const [windowEnabled, setWindowEnabled] = useState(Boolean(rule?.window));
  const [windowStart, setWindowStart] = useState(rule?.window?.start ?? "");
  const [windowEnd, setWindowEnd] = useState(rule?.window?.end ?? "");
  const [weekdays, setWeekdays] = useState(rule?.window?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
  const [exceptions, setExceptions] = useState(rule?.exceptions.join("\n") ?? "");
  const [behaviorId, setBehaviorId] = useState(rule?.condition?.behaviorId ?? "");
  const [comparison, setComparison] = useState<RuleCondition["comparison"]>(
    rule?.condition?.comparison ?? "at_least",
  );
  const [value, setValue] = useState(
    rule?.condition && rule.condition.comparison !== "status_is"
      ? rule.condition.value.toString()
      : "",
  );
  const [status, setStatus] = useState<ProgressStatus>(
    rule?.condition?.comparison === "status_is" ? rule.condition.status : "done",
  );
  const [version, setVersion] = useState(rule?.version ?? null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const behavior = behaviors.find((item) => item.id === behaviorId);
  const conflict = Boolean(rule && latest?.version !== version);
  const archived = latest?.state === "archived";
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  async function save() {
    if (writing.current || conflict || archived) return;
    if (!name.trim() || !meaning.trim() || !reason.trim() || !scope.trim()) {
      setError("Describe the rule, its meaning, reason and scope.");
      return;
    }
    const exceptionList = exceptions
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean);
    if (exceptionList.length > 8) {
      setError("Keep agreed exceptions to eight short items or fewer.");
      return;
    }
    if (windowEnabled && (!weekdays.length || !windowStart || !windowEnd)) {
      setError("Choose the rule window's hours and weekdays.");
      return;
    }
    if (
      behaviorId &&
      (!behavior ||
        (comparison !== "status_is" &&
          (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || !value)))
    ) {
      setError("Choose a shared subject and its agreed condition.");
      return;
    }
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const effectiveAt =
        rule && JSON.stringify(start) === JSON.stringify(initialStart.current)
          ? rule.effectiveAt
          : (await resolveTimeDraft(api, start)).time.at;
      const expiresAt =
        rule && JSON.stringify(expiry) === JSON.stringify(initialExpiry.current)
          ? rule.expiresAt
          : (await resolveTimeDraft(api, expiry)).time.at;
      if (!effectiveAt) throw new Error("Choose when the rule begins.");
      const condition: RuleCondition | null = behaviorId
        ? comparison === "status_is"
          ? { behaviorId, comparison, status }
          : { behaviorId, comparison, value: Number(value) }
        : null;
      const fields: RuleSaveInput = {
        name: name.trim(),
        meaning: meaning.trim(),
        reason: reason.trim(),
        scope: scope.trim(),
        effectiveAt,
        expiresAt,
        timezone: start.timezone,
        window: windowEnabled ? { start: windowStart, end: windowEnd, weekdays } : null,
        exceptions: exceptionList,
        condition,
        ...(rule ? { id: rule.id, expectedVersion: version as number } : {}),
      };
      const result = await api<{ rule: RuleDefinition }>(
        rule ? `/agreements/rules/${encodeURIComponent(rule.id)}` : "/agreements/rules",
        { method: rule ? "PUT" : "POST", body: JSON.stringify(fields) },
      );
      onSaved(result.rule);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      writing.current = false;
      setBusy(false);
      onBusyChange(false);
      onRefresh();
    }
  }
  return (
    <article className="panel dynamic-panel agreement-editor" aria-labelledby="rule-editor-title">
      <h2 id="rule-editor-title">{rule ? "Edit rule" : "New rule"}</h2>
      <p className="dynamic-intro">
        Save an actual agreement, including what it means and its exceptions. Honest feelings and
        uncertainty remain welcome.
      </p>
      {error && <ErrorNotice message={error} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Rule agreement</legend>
          <label className="dynamic-field">
            <span>Name</span>
            <input
              required
              maxLength={120}
              aria-label="Rule name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>What the agreement means</span>
            <textarea
              required
              rows={3}
              maxLength={800}
              aria-label="Rule meaning"
              value={meaning}
              onChange={(event) => {
                setMeaning(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Why it matters</span>
            <textarea
              required
              rows={2}
              maxLength={600}
              aria-label="Rule reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Scope</span>
            <textarea
              required
              rows={2}
              maxLength={400}
              aria-label="Rule scope"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setEdited(true);
              }}
            />
            <small>Describe the situations and behavior this agreement actually covers.</small>
          </label>
          <label className="dynamic-field">
            <span>Timezone</span>
            <input
              required
              maxLength={100}
              aria-label="Rule timezone"
              value={start.timezone}
              onChange={(event) => {
                setStart({ ...start, timezone: event.target.value });
                setExpiry({ ...expiry, timezone: event.target.value });
                setEdited(true);
              }}
            />
          </label>
          <DailyTimeField
            label="Rule begins"
            draft={start}
            allowUnknown={false}
            disabled={busy}
            onChange={(next) => {
              setStart(next);
              setEdited(true);
            }}
          />
          <DailyTimeField
            label="Rule expires"
            draft={expiry}
            allowNow={false}
            unknownLabel="No expiry"
            disabled={busy}
            onChange={(next) => {
              setExpiry(next);
              setEdited(true);
            }}
          />
          <ToggleOption
            title="Apply during specific hours"
            checked={windowEnabled}
            onChange={(checked) => {
              setWindowEnabled(checked);
              setEdited(true);
            }}
          >
            Otherwise the rule applies whenever its saved scope is relevant.
          </ToggleOption>
          {windowEnabled && (
            <>
              <div className="agreement-time-grid">
                <label className="dynamic-field">
                  <span>Window begins</span>
                  <input
                    required
                    type="time"
                    aria-label="Rule window start"
                    value={windowStart}
                    onChange={(event) => {
                      setWindowStart(event.target.value);
                      setEdited(true);
                    }}
                  />
                </label>
                <label className="dynamic-field">
                  <span>Window ends</span>
                  <input
                    required
                    type="time"
                    aria-label="Rule window end"
                    value={windowEnd}
                    onChange={(event) => {
                      setWindowEnd(event.target.value);
                      setEdited(true);
                    }}
                  />
                </label>
              </div>
              <AgreementWeekdays
                label="Rule window weekdays"
                value={weekdays}
                disabled={busy}
                onChange={(next) => {
                  setWeekdays(next);
                  setEdited(true);
                }}
              />
              <p className="dynamic-field-hint">
                Overnight hours belong to the weekday they begin. Equal start and end times mean all
                day on the selected weekdays.
              </p>
            </>
          )}
          <label className="dynamic-field">
            <span>
              Agreed exceptions <small>Optional</small>
            </span>
            <textarea
              rows={3}
              maxLength={1927}
              aria-label="Rule exceptions"
              value={exceptions}
              onChange={(event) => {
                setExceptions(event.target.value);
                setEdited(true);
              }}
            />
            <small>One short exception per line, up to eight.</small>
          </label>
          <details className="agreement-advanced">
            <summary>Use a shared reported condition</summary>
            <div className="dynamic-fields">
              <label className="dynamic-field">
                <span>Tracking subject</span>
                <select
                  aria-label="Rule tracking subject"
                  value={behaviorId}
                  onChange={(event) => {
                    const item = behaviors.find((entry) => entry.id === event.target.value);
                    setBehaviorId(event.target.value);
                    setComparison(item?.valueKind === "status" ? "status_is" : "at_least");
                    setValue("");
                    setEdited(true);
                  }}
                >
                  <option value="">No measured condition</option>
                  {behaviors
                    .filter((item) => item.state === "active" || item.id === behaviorId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              {behaviorId &&
                (behavior?.valueKind === "status" ? (
                  <label className="dynamic-field">
                    <span>Agreed reported status</span>
                    <select
                      aria-label="Rule status condition"
                      value={status}
                      onChange={(event) => {
                        setStatus(event.target.value as ProgressStatus);
                        setEdited(true);
                      }}
                    >
                      {Object.entries(progressStatusLabels).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <>
                    <label className="dynamic-field">
                      <span>Condition</span>
                      <select
                        aria-label="Rule comparison"
                        value={comparison}
                        onChange={(event) => {
                          setComparison(event.target.value as typeof comparison);
                          setEdited(true);
                        }}
                      >
                        <option value="at_least">At least</option>
                        <option value="at_most">At most</option>
                        <option value="equals">Exactly</option>
                      </select>
                    </label>
                    <label className="dynamic-field">
                      <span>
                        Amount <small>{behavior?.unit}</small>
                      </span>
                      <input
                        required
                        type="number"
                        min={0}
                        max={1000000}
                        step={1}
                        aria-label="Rule condition amount"
                        value={value}
                        onChange={(event) => {
                          setValue(event.target.value);
                          setEdited(true);
                        }}
                      />
                    </label>
                  </>
                ))}
              <p className="dynamic-field-hint">
                Uses the same reported evidence as Daily Details. A missing or uncertain report does
                not establish a violation.
              </p>
            </div>
          </details>
        </fieldset>
        {(conflict || archived) && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              {archived
                ? "This rule was archived. Your draft is kept so you can copy any changes."
                : "This rule changed elsewhere. Your draft is kept; compare the saved agreement before continuing."}
            </p>
            {latest && (
              <div className="dynamic-saved-version">
                <strong>{latest.name}</strong>
                <p>{latest.meaning}</p>
                <p>{latest.scope}</p>
                <p>
                  From {dailyTime(latest.effectiveAt, latest.timezone)}
                  {latest.expiresAt ? ` until ${dailyTime(latest.expiresAt, latest.timezone)}` : ""}{" "}
                  · {latest.state}
                </p>
              </div>
            )}
            {!archived && latest && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setVersion(latest.version);
                  setError("");
                }}
              >
                Keep my rule draft over the latest version
              </button>
            )}
          </div>
        )}
        <div className="dynamic-actions dynamic-save">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !edited || conflict || archived}
          >
            {busy ? "Saving…" : "Save rule"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (!edited || window.confirm("Discard the unsaved rule changes?")) onClose();
            }}
          >
            Cancel rule edit
          </button>
        </div>
      </form>
    </article>
  );
}
