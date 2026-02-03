import { useCallback } from 'preact/hooks';
import styles from './VectorInput.module.css';

export interface VectorInputProps {
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
  step?: number;
  onReset?: () => void;
  disabled?: boolean;
}

export function VectorInput({
  label,
  value,
  onChange,
  step = 0.1,
  onReset,
  disabled = false,
}: VectorInputProps) {
  const handleAxisChange = useCallback(
    (axis: 0 | 1 | 2) => (e: Event) => {
      const target = e.target as HTMLInputElement;
      const newValue = [...value] as [number, number, number];
      newValue[axis] = parseFloat(target.value) || 0;
      onChange(newValue);
    },
    [value, onChange]
  );

  return (
    <div class={styles.container}>
      <div class={styles.header}>
        <label class={styles.label}>{label}</label>
        {onReset && (
          <button
            class={styles.resetBtn}
            onClick={onReset}
            title="Reset"
            type="button"
          >
            ⟲
          </button>
        )}
      </div>
      <div class={styles.inputs}>
        <div class={styles.inputWrapper}>
          <span class={styles.axisLabel}>X</span>
          <input
            type="number"
            class={styles.input}
            value={value[0].toFixed(2)}
            step={step}
            onInput={handleAxisChange(0)}
            disabled={disabled}
          />
        </div>
        <div class={styles.inputWrapper}>
          <span class={styles.axisLabel}>Y</span>
          <input
            type="number"
            class={styles.input}
            value={value[1].toFixed(2)}
            step={step}
            onInput={handleAxisChange(1)}
            disabled={disabled}
          />
        </div>
        <div class={styles.inputWrapper}>
          <span class={styles.axisLabel}>Z</span>
          <input
            type="number"
            class={styles.input}
            value={value[2].toFixed(2)}
            step={step}
            onInput={handleAxisChange(2)}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
