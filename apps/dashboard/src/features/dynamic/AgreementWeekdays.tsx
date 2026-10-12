import { weekdayLabels } from "./agreement-presentation";

export function AgreementWeekdays({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number[];
  onChange: (days: number[]) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="agreement-weekdays" disabled={disabled}>
      <legend>{label}</legend>
      {weekdayLabels.map((day, index) => (
        <label key={day}>
          <input
            type="checkbox"
            checked={value.includes(index)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, index].sort((a, b) => a - b)
                  : value.filter((item) => item !== index),
              )
            }
          />
          <span>{day}</span>
        </label>
      ))}
    </fieldset>
  );
}
