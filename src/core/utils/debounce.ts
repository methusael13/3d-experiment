/**
 * Creates a debounced function that delays invoking `fn` until after `wait` milliseconds
 * have elapsed since the last time the debounced function was invoked.
 * 
 * @param fn - The function to debounce
 * @param wait - Milliseconds to wait before invoking
 * @returns Debounced function with cancel() method
 * 
 * @example
 * const debouncedSave = debounce(() => saveData(), 500);
 * input.addEventListener('input', debouncedSave);
 * // Later: debouncedSave.cancel() to prevent pending execution
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  wait: number
): T & { cancel: () => void } {
  let timeoutId: number | null = null;
  
  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      timeoutId = null;
      fn(...args);
    }, wait);
  }) as T & { cancel: () => void };
  
  debounced.cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  
  return debounced;
}
