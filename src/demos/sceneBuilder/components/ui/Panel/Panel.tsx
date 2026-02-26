import { ComponentChildren } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import styles from './Panel.module.css';

export interface PanelProps {
  title: string;
  children: ComponentChildren;
  visible?: boolean;
  defaultCollapsed?: boolean;
  maxHeight?: number;
}

export function Panel({ 
  title, 
  children, 
  visible = true, 
  defaultCollapsed = false,
  maxHeight = 600,
}: PanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  
  const toggleCollapsed = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  if (!visible) return null;

  return (
    <div class={styles.panel}>
      <div class={styles.header} onClick={toggleCollapsed}>
        <span class={`${styles.arrow} ${isCollapsed ? styles.collapsed : ''}`}>▼</span>
        <h3 class={styles.title}>{title}</h3>
      </div>
      <div 
        class={`${styles.content} ${isCollapsed ? styles.contentCollapsed : ''}`}
        style={!isCollapsed ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
