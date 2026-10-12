import type { ReactNode } from "react";

/** A labelled checkbox with a short explanation of its effect. */
export function ToggleOption({
  title,
  children,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  children: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="dynamic-permission">
      <input
        type="checkbox"
        disabled={disabled}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{title}</strong>
        <small>{children}</small>
      </span>
    </label>
  );
}
