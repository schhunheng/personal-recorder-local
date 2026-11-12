import { cloneElement, isValidElement, useId, type ReactNode } from 'react';
export function Toggle({
  label,
  checked,
  onChange,
  description,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="toggle-row">
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}
export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const id = useId();
  return (
    <label className="slider-field" htmlFor={id}>
      <span>
        {label}
        <output>
          {Number(value.toFixed(2))}
          {suffix}
        </output>
      </span>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
      />
    </label>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const generatedId = useId();
  const control = isValidElement<{ id?: string; 'aria-labelledby'?: string }>(children)
    ? children
    : undefined;
  const id = control?.props.id || generatedId;
  const labelId = `${id}-label`;
  return (
    <label className="field" htmlFor={control ? id : undefined}>
      <span id={labelId}>{label}</span>
      {control ? cloneElement(control, {
        id,
        'aria-labelledby': control.props['aria-labelledby'] || labelId,
      }) : children}
    </label>
  );
}
