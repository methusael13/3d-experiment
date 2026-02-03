import { ComponentChildren } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import styles from './Section.module.css';

export interface SectionProps {
  title: string;
  children: ComponentChildren;
  defaultCollapsed?: boolean;
}

export function Section({
  title,
  children,
  defaultCollapsed = false,
}: SectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  return (
    <div class={`${styles.section} ${collapsed ? styles.collapsed : ''}`}>
      <h3 class={styles.title} onClick={toggleCollapsed}>
        <span class={styles.arrow}>{collapsed ? '▶' : '▼'}</span>
        {title}
      </h3>
      {!collapsed && <div class={styles.content}>{children}</div>}
    </div>
  );
}
