import { useCallback } from 'preact/hooks';
import styles from './Select.module.css';
import { Signalish } from 'preact';

export interface SelectOption<T = string> {
  value: T;
  label: string;
}

export interface SelectProps<T = string> {
  label?: string;
  value: string;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}

export function Select<T = string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SelectProps<T>) {
  const handleChange = useCallback(
    (e: Event) => {
      const target = e.target as HTMLSelectElement;
      onChange(target.value as T);
    },
    [onChange]
  );

  return (
    <div class={styles.container}>
      {label && <label class={styles.label}>{label}</label>}
      <select
        class={styles.select}
        value={value}
        onChange={handleChange}
        disabled={disabled}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value as Signalish<string>}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
