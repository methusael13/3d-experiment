import { useCallback } from 'preact/hooks';
import styles from './ColorPicker.module.css';

export interface ColorPickerProps {
  label: string;
  value: [number, number, number]; // RGB 0-1
  onChange: (color: [number, number, number]) => void;
  disabled?: boolean;
}

function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (n: number) => {
    const h = Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
  };
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return [
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255,
    ];
  }
  return [0.5, 0.5, 0.5];
}

export function ColorPicker({
  label,
  value,
  onChange,
  disabled = false,
}: ColorPickerProps) {
  const handleChange = useCallback(
    (e: Event) => {
      const target = e.target as HTMLInputElement;
      onChange(hexToRgb(target.value));
    },
    [onChange]
  );

  return (
    <div class={styles.container}>
      <label class={styles.label}>{label}</label>
      <input
        type="color"
        class={styles.input}
        value={rgbToHex(value)}
        onInput={handleChange}
        disabled={disabled}
      />
    </div>
  );
}
