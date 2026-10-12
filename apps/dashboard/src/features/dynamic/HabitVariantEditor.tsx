import type { DailyEvent, DynamicPage, HabitOpportunity, HabitVariantRecord } from "@valerie/core";
import { useEffect, useRef, useState } from "react";
import { type Api, errorMessage } from "../../app/api";
import { ErrorNotice } from "../../components/ui";
import { dailyTime } from "./daily-presentation";
import { FocusSources } from "./FocusNotes";

export function HabitVariantEditor({
  api,
  opportunity,
  onRefresh,
  onClose,
  onDirtyChange,
  onBusyChange,
}: {
  api: Api;
  opportunity: HabitOpportunity;
  onRefresh: () => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [events, setEvents] = useState<DailyEvent[]>([]);
  const [record, setRecord] = useState<HabitVariantRecord | null>(null);
  const [eventId, setEventId] = useState("");
  const [variant, setVariant] = useState<"full" | "smaller">(
    opportunity.definition.smallerPractice ? "smaller" : "full",
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const writing = useRef(false);
  const editedRef = useRef(false);
  useEffect(() => onDirtyChange(edited || busy), [edited, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh keeps the chosen draft while loading current reports and declaration versions.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const eventsRequest = api<DynamicPage<DailyEvent>>(
      `/dynamic/daily/events?dayId=${encodeURIComponent(opportunity.wakingDayId)}&behaviorId=${encodeURIComponent(opportunity.definition.behaviorId)}&limit=50`,
      { signal: controller.signal },
    );
    const variantRequest = opportunity.variantRecordId
      ? api<{ variant: HabitVariantRecord }>(
          `/agreements/variants/${encodeURIComponent(opportunity.variantRecordId)}`,
          { signal: controller.signal },
        )
      : Promise.resolve(null);
    void Promise.all([eventsRequest, variantRequest])
      .then(([reports, saved]) => {
        if (controller.signal.aborted) return;
        setEvents(
          reports.items.filter((event) => {
            if (
              event.state !== "active" ||
              event.evidenceKind === "valerie_interpretation" ||
              event.payload.kind !== "progress"
            )
              return false;
            return event.payload.mode === "status"
              ? ["done", "partial"].includes(event.payload.status ?? "")
              : ["occurrence", "total_so_far"].includes(event.payload.mode) &&
                  (event.payload.value ?? 0) > 0;
          }),
        );
        setRecord(saved?.variant ?? null);
        if (saved && !editedRef.current) {
          setEventId(saved.variant.eventId);
          setVariant(saved.variant.variant);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    api,
    opportunity.wakingDayId,
    opportunity.definition.behaviorId,
    opportunity.variantRecordId,
    refresh,
  ]);
  async function save(withdraw = false) {
    if (writing.current) return;
    const event = events.find((item) => item.id === eventId);
    if (!withdraw && !event) {
      setError("Choose a positive reported action for this habit and waking day.");
      return;
    }
    if (withdraw && !record) return;
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      if (withdraw && record)
        await api(`/agreements/variants/${encodeURIComponent(record.id)}/void`, {
          method: "POST",
          body: JSON.stringify({ expectedVersion: record.version }),
        });
      else
        await api("/agreements/variants", {
          method: "POST",
          body: JSON.stringify({
            habitId: opportunity.habitId,
            wakingDayId: opportunity.wakingDayId,
            definitionVersion: opportunity.definitionVersion,
            eventId: event?.id,
            expectedEventVersion: event?.version,
            variant,
            ...(record ? { id: record.id, expectedVersion: record.version } : {}),
          }),
        });
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
    <article
      className="panel dynamic-panel agreement-editor"
      aria-labelledby="variant-editor-title"
    >
      <h2 id="variant-editor-title">Reported practice: {opportunity.definition.name}</h2>
      <p className="dynamic-intro">
        Link the agreed version to an existing action. This does not add another action to the
        shared count.
      </p>
      {error && <ErrorNotice message={error} />}
      <button
        type="button"
        className="text-button"
        disabled={busy || loading}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh reported actions
      </button>
      {loading ? (
        <p className="muted">Loading reported actions…</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="dynamic-fields" disabled={busy}>
            <legend className="sr-only">Practice version</legend>
            <label className="dynamic-field">
              <span>Reported action</span>
              <select
                required
                aria-label="Habit variant report"
                value={eventId}
                onChange={(event) => {
                  setEventId(event.target.value);
                  editedRef.current = true;
                  setEdited(true);
                }}
              >
                <option value="">Choose an actual report</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>
                    {event.summary} · {dailyTime(event.occurred.at, event.occurred.timezone)}
                  </option>
                ))}
              </select>
            </label>
            {events.length === 0 && (
              <p className="dynamic-field-hint">
                No qualifying positive report is available. Plans, interpretations and reported zero
                do not establish completion.
              </p>
            )}
            <label className="dynamic-field">
              <span>Agreed practice used</span>
              <select
                aria-label="Habit practice version"
                value={variant}
                onChange={(event) => {
                  setVariant(event.target.value as typeof variant);
                  editedRef.current = true;
                  setEdited(true);
                }}
              >
                <option value="full">Full practice</option>
                {opportunity.definition.smallerPractice && (
                  <option value="smaller">Smaller version</option>
                )}
              </select>
              <small>
                {variant === "smaller"
                  ? opportunity.definition.smallerPractice
                  : opportunity.definition.fullPractice}
              </small>
            </label>
          </fieldset>
          {record && (
            <FocusSources api={api} sources={record.sources} label="Practice declaration context" />
          )}
          <div className="dynamic-actions dynamic-save">
            <button
              type="submit"
              className="button button--primary"
              disabled={busy || !eventId || !edited}
            >
              {busy ? "Saving…" : "Save reported practice"}
            </button>
            {record && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Withdraw practice declaration
              </button>
            )}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (!edited || window.confirm("Discard the unsaved practice declaration?"))
                  onClose();
              }}
            >
              Cancel practice edit
            </button>
          </div>
        </form>
      )}
    </article>
  );
}
