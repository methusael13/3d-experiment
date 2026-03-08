import { useState, useCallback, useRef } from 'preact/hooks';
import styles from './NumberInput.module.css';

export interface NumberInputProps {
  /** Current value */
  value: number;
  /** Called when value is committed (Enter key or blur) */
  onChange: (value: number) => void;
  /** Step increment for arrow keys / spinner (default: 1) */
  step?: number;
  /** Minimum allowed value (default: none) */
  min?: number;
  /** Maximum allowed value (default: none) */
  max?: number;
  /** Default value when input is empty on commit (default: 0) */
  defaultValue?: number;
  /** Label text (optional) */
  label?: string;
  /** Input width in CSS (default: '60px') */
  width?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Number of decimal places to display (default: auto) */
  precision?: number;
}

/**
 * Themed numeric input component with commit-on-blur/enter behavior.
 * 
 * - Allows free text editing (including deleting to empty)
 * - Commits on Enter or blur
 * - Empty input commits as defaultValue (0 by default)
 * - Respects min/max/step
 * - Matches the scene builder dark theme
 */
export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  defaultValue = 0,
  label,
  width = '60px',
  disabled = false,
  precision,
}: NumberInputProps) {
  // Local string state for free editing
  const [editing, setEditing] = useState(false);
  const [localValue, setLocalValue] = useState('');

  const format = (v: number) => {
    if (precision !== undefined) return v.toFixed(precision);
    // Auto-format: if step is fractional, show appropriate decimals
    if (step < 1) {
      const decimals = Math.max(1, -Math.floor(Math.log10(step)));
      return v.toFixed(decimals);
    }
    // Integer step: show as-is (no trailing zeros)
    return String(v);
  };

  const commit = useCallback((raw: string) => {
    let parsed = parseFloat(raw);
    if (isNaN(parsed) || raw.trim() === '') {
      parsed = defaultValue;
    }
    if (min !== undefined) parsed = Math.max(min, parsed);
    if (max !== undefined) parsed = Math.min(max, parsed);
    onChange(parsed);
    setEditing(false);
  }, [onChange, defaultValue, min, max]);

  const handleFocus = useCallback(() => {
    setEditing(true);
    setLocalValue(format(value));
  }, [value, precision, step]);

  const handleBlur = useCallback(() => {
    commit(localValue);
  }, [localValue, commit]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      commit(localValue);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setEditing(false);
      setLocalValue(format(value));
    }
  }, [localValue, commit, value, precision, step]);

  const handleInput = useCallback((e: Event) => {
    setLocalValue((e.target as HTMLInputElement).value);
  }, []);

  const displayValue = editing ? localValue : format(value);

  const input = (
    <input
      type="text"
      inputMode="decimal"
      class={styles.input}
      style={{ width }}
      value={displayValue}
      disabled={disabled}
      step={step}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onInput={handleInput}
    />
  );

  if (label) {
    return (
      <label class={styles.row}>
        <span class={styles.label}>{label}</span>
        {input}
      </label>
    );
  }

  return input;
}