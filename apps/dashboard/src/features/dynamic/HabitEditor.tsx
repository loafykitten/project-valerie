import type { CheckinSlot, HabitDefinition, HabitSaveInput, ProgressBehavior } from "@valerie/core";
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
import { dailyTime } from "./daily-presentation";

export function HabitEditor({
  api,
  habit,
  latest,
  behaviors,
  timezone,
  onSaved,
  onRefresh,
  onClose,
  onOpenDaily,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  habit: HabitDefinition | null;
  latest: HabitDefinition | null;
  behaviors: ProgressBehavior[];
  timezone: string;
  onSaved: (habit: HabitDefinition) => void;
  onRefresh: () => void;
  onClose: () => void;
  onOpenDaily: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const initialTime = useRef(
    habit
      ? timeDraftFromReported({ at: habit.effectiveAt, timezone, basis: "exact" })
      : newTimeDraft(timezone),
  );
  const [name, setName] = useState(habit?.name ?? "");
  const [reason, setReason] = useState(habit?.reason ?? "");
  const [behaviorId, setBehaviorId] = useState(habit?.behaviorId ?? "");
  const [practice, setPractice] = useState(habit?.fullPractice ?? "");
  const [smaller, setSmaller] = useState(habit?.smallerPractice ?? "");
  const [cadence, setCadence] = useState<"every_waking_day" | "weekdays">(
    habit?.cadence.kind ?? "every_waking_day",
  );
  const [weekdays, setWeekdays] = useState(
    habit?.cadence.kind === "weekdays" ? habit.cadence.weekdays : [],
  );
  const [slots, setSlots] = useState<CheckinSlot[]>(habit?.slots ?? ["morning", "evening"]);
  const [threshold, setThreshold] = useState(habit?.threshold?.toString() ?? "");
  const [effective, setEffective] = useState(initialTime.current);
  const [version, setVersion] = useState(habit?.version ?? null);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writing = useRef(false);
  const behavior = behaviors.find((item) => item.id === behaviorId);
  const conflict = Boolean(habit && latest?.version !== version);
  const archived = latest?.state === "archived";
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  async function save() {
    if (writing.current || conflict || archived) return;
    if (!name.trim() || !reason.trim() || !practice.trim() || !behavior) {
      setError("Add a name, reason, full practice and shared tracking subject.");
      return;
    }
    if (cadence === "weekdays" && !weekdays.length) {
      setError("Choose at least one weekday.");
      return;
    }
    if (!slots.length) {
      setError("Choose morning, evening or both check-in slots.");
      return;
    }
    if (
      behavior.valueKind === "count" &&
      (!Number.isSafeInteger(Number(threshold)) || Number(threshold) < 1)
    ) {
      setError("Choose an agreed positive amount for the full practice.");
      return;
    }
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      const at =
        habit && JSON.stringify(effective) === JSON.stringify(initialTime.current)
          ? habit.effectiveAt
          : (await resolveTimeDraft(api, effective)).time.at;
      if (!at) throw new Error("Choose when the habit begins.");
      const fields: HabitSaveInput = {
        name: name.trim(),
        reason: reason.trim(),
        behaviorId,
        fullPractice: practice.trim(),
        smallerPractice: smaller.trim() || null,
        cadence: cadence === "every_waking_day" ? { kind: cadence } : { kind: cadence, weekdays },
        slots,
        effectiveAt: at,
        threshold: behavior.valueKind === "count" ? Number(threshold) : null,
        ...(habit ? { id: habit.id, expectedVersion: version as number } : {}),
      };
      const result = await api<{ habit: HabitDefinition }>(
        habit ? `/agreements/habits/${encodeURIComponent(habit.id)}` : "/agreements/habits",
        { method: habit ? "PUT" : "POST", body: JSON.stringify(fields) },
      );
      onSaved(result.habit);
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
    <article className="panel dynamic-panel agreement-editor" aria-labelledby="habit-editor-title">
      <h2 id="habit-editor-title">{habit ? "Edit habit" : "New habit"}</h2>
      <p className="dynamic-intro">
        Save the actual practice and when it applies. Existing opportunities keep the version they
        began with.
      </p>
      {error && <ErrorNotice message={error} />}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="dynamic-fields" disabled={busy}>
          <legend className="sr-only">Habit agreement</legend>
          <label className="dynamic-field">
            <span>Name</span>
            <input
              required
              maxLength={120}
              aria-label="Habit name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Why this matters</span>
            <textarea
              required
              rows={2}
              maxLength={600}
              aria-label="Habit reason"
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          <label className="dynamic-field">
            <span>Shared tracking subject</span>
            <select
              required
              aria-label="Habit tracking subject"
              value={behaviorId}
              onChange={(event) => {
                setBehaviorId(event.target.value);
                setThreshold("");
                setEdited(true);
              }}
            >
              <option value="">Choose a subject</option>
              {behaviors
                .filter((item) => item.state === "active" || item.id === behaviorId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.state === "archived" ? " (archived)" : ""}
                  </option>
                ))}
            </select>
            <small>
              Uses the same reports as Daily Details. A different action needs its own subject.
            </small>
          </label>
          <button type="button" className="text-button agreement-inline-link" onClick={onOpenDaily}>
            Manage tracking subjects in Daily Details
          </button>
          <label className="dynamic-field">
            <span>The full practice</span>
            <textarea
              required
              rows={3}
              maxLength={600}
              aria-label="Full habit practice"
              value={practice}
              onChange={(event) => {
                setPractice(event.target.value);
                setEdited(true);
              }}
            />
          </label>
          {behavior?.valueKind === "count" && (
            <label className="dynamic-field">
              <span>
                Amount for the full practice <small>{behavior.unit}</small>
              </span>
              <input
                required
                type="number"
                min={1}
                max={1000000}
                step={1}
                aria-label="Habit full amount"
                value={threshold}
                onChange={(event) => {
                  setThreshold(event.target.value);
                  setEdited(true);
                }}
              />
              <small>This amount or more meets the full practice.</small>
            </label>
          )}
          <label className="dynamic-field">
            <span>
              Agreed smaller version <small>Optional</small>
            </span>
            <textarea
              rows={2}
              maxLength={400}
              aria-label="Smaller habit practice"
              value={smaller}
              onChange={(event) => {
                setSmaller(event.target.value);
                setEdited(true);
              }}
            />
            <small>
              A smaller version is linked to an actual report, not inferred from silence or a plan.
            </small>
          </label>
          <label className="dynamic-field">
            <span>Cadence</span>
            <select
              aria-label="Habit cadence"
              value={cadence}
              onChange={(event) => {
                setCadence(event.target.value as typeof cadence);
                setEdited(true);
              }}
            >
              <option value="every_waking_day">Each waking day</option>
              <option value="weekdays">Selected weekdays</option>
            </select>
          </label>
          {cadence === "weekdays" && (
            <AgreementWeekdays
              label="Habit weekdays"
              value={weekdays}
              disabled={busy}
              onChange={(value) => {
                setWeekdays(value);
                setEdited(true);
              }}
            />
          )}
          <fieldset className="agreement-weekdays" disabled={busy}>
            <legend>Include in coordinated check-ins</legend>
            {(["morning", "evening"] as const).map((slot) => (
              <label key={slot}>
                <input
                  type="checkbox"
                  checked={slots.includes(slot)}
                  onChange={(event) => {
                    setSlots(
                      event.target.checked
                        ? [...slots, slot]
                        : slots.filter((item) => item !== slot),
                    );
                    setEdited(true);
                  }}
                />
                <span>{slot === "morning" ? "Morning" : "Evening"}</span>
              </label>
            ))}
          </fieldset>
          <DailyTimeField
            label="Habit begins"
            draft={effective}
            allowUnknown={false}
            disabled={busy}
            onChange={(value) => {
              setEffective(value);
              setEdited(true);
            }}
          />
        </fieldset>
        {(conflict || archived) && (
          <div className="notice dynamic-conflict" role="status">
            <p>
              {archived
                ? "This habit was archived. Your draft is kept so you can copy any changes."
                : "This habit changed elsewhere. Your draft is kept; compare the saved version before continuing."}
            </p>
            {latest && (
              <div className="dynamic-saved-version">
                <strong>{latest.name}</strong>
                <p>{latest.fullPractice}</p>
                <p>{latest.smallerPractice}</p>
                <p>
                  {dailyTime(latest.effectiveAt, timezone)} · {latest.state}
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
                Keep my habit draft over the latest version
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
            {busy ? "Saving…" : "Save habit"}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => {
              if (!edited || window.confirm("Discard the unsaved habit changes?")) onClose();
            }}
          >
            Cancel habit edit
          </button>
        </div>
      </form>
    </article>
  );
}
