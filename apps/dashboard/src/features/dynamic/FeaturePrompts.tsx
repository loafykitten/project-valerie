import { useEffect, useMemo, useState } from "react";
import type { Api } from "../../app/api";
import { FeaturePromptEditor } from "./FeaturePromptEditor";

const features = [
  {
    id: "growth-focus",
    label: "Growth Focus",
    title: "Growth Focus",
    description:
      "How Valerie uses your focus and progress notes. Your saved character and relationship prompts still shape her voice.",
  },
  {
    id: "daily-records",
    label: "Daily Records",
    title: "Daily Records",
    description:
      "How Valerie understands your waking day and keeps source-backed progress records. Plans, uncertainty and interpretations stay distinct from things you report doing.",
  },
  {
    id: "habits",
    label: "Habits",
    title: "Habits",
    description:
      "How Valerie supports agreed practices, including smaller versions, reporting gaps and getting started again.",
  },
  {
    id: "rules",
    label: "Rules",
    title: "Rules",
    description:
      "How Valerie refers to your current agreements while preserving honest feelings, exceptions and uncertainty.",
  },
  {
    id: "reminders",
    label: "Reminders",
    title: "Reminder Delivery",
    description:
      "How Valerie phrases scheduled reminders and coordinated check-ins. The saved schedules and delivery records determine when messages are sent.",
  },
] as const;

export function FeaturePrompts({
  api,
  visible,
  onDirtyChange,
}: {
  api: Api;
  visible: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [selected, setSelected] = useState<string>("growth-focus");
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const dirtyHandlers = useMemo(
    () =>
      Object.fromEntries(
        features.map((feature) => [
          feature.id,
          (value: boolean) =>
            setDirty((previous) =>
              previous[feature.id] === value ? previous : { ...previous, [feature.id]: value },
            ),
        ]),
      ),
    [],
  );
  const hasDrafts = Object.values(dirty).some(Boolean);
  useEffect(() => onDirtyChange(hasDrafts), [hasDrafts, onDirtyChange]);
  return (
    <section className="dynamic-feature-prompts" aria-label="Feature prompts">
      <fieldset className="segmented dynamic-tabs">
        <legend className="sr-only">Feature prompt selection</legend>
        {features.map((feature) => (
          <button
            type="button"
            key={feature.id}
            className={selected === feature.id ? "is-active" : ""}
            aria-pressed={selected === feature.id}
            onClick={() => setSelected(feature.id)}
          >
            {feature.label}
            {dirty[feature.id] ? " •" : ""}
          </button>
        ))}
      </fieldset>
      {features.map((feature) => (
        <div key={feature.id} hidden={selected !== feature.id}>
          <FeaturePromptEditor
            api={api}
            visible={visible && selected === feature.id}
            onDirtyChange={dirtyHandlers[feature.id] ?? (() => {})}
            promptId={feature.id}
            title={feature.title}
            description={feature.description}
          />
        </div>
      ))}
    </section>
  );
}
