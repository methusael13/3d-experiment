import { useCallback } from 'preact/hooks';
import styles from './Checkbox.module.css';

export interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
}: CheckboxProps) {
  const handleChange = useCallback(
    (e: Event) => {
      const target = e.target as HTMLInputElement;
      onChange(target.checked);
    },
    [onChange]
  );

  return (
    <label class={styles.container}>
      <input
        type="checkbox"
        class={styles.checkbox}
        checked={checked}
        onChange={handleChange}
        disabled={disabled}
      />
      <span class={styles.label}>{label}</span>
    </label>
  );
}
