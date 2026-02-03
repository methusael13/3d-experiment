import { useCallback } from 'preact/hooks';
import styles from './Slider.module.css';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 0.1,
  format = (v) => v.toFixed(1),
  onChange,
  disabled = false,
}: SliderProps) {
  const handleChange = useCallback(
    (e: Event) => {
      const target = e.target as HTMLInputElement;
      onChange(parseFloat(target.value));
    },
    [onChange]
  );

  return (
    <div class={styles.container}>
      <div class={styles.header}>
        <label class={styles.label}>{label}</label>
        <span class={styles.value}>{format(value)}</span>
      </div>
      <input
        type="range"
        class={styles.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={handleChange}
        disabled={disabled}
      />
    </div>
  );
}
