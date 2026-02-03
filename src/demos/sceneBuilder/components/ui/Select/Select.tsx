import { useCallback } from 'preact/hooks';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SelectProps) {
  const handleChange = useCallback(
    (e: Event) => {
      const target = e.target as HTMLSelectElement;
      onChange(target.value);
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
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
