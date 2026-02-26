import { ComponentChildren } from 'preact';
import { useState, useCallback, useEffect, useMemo } from 'preact/hooks';
import styles from './SidebarTabs.module.css';

export interface SidebarTab {
  id: string;
  /** Emoji or single character used as the icon */
  icon: string;
  /** Tooltip / accessible label */
  label: string;
  content: ComponentChildren;
  visible?: boolean;
}

export interface SidebarTabsProps {
  tabs: SidebarTab[];
  defaultTab?: string;
}

export function SidebarTabs({ tabs, defaultTab }: SidebarTabsProps) {
  const visibleTabs = useMemo(
    () => tabs.filter((t) => t.visible !== false),
    [tabs]
  );

  const visibleIds = useMemo(
    () => visibleTabs.map((t) => t.id),
    [visibleTabs]
  );

  const [activeTab, setActiveTab] = useState(defaultTab || visibleIds[0]);

  // When visible tabs change (selection change, tab visibility toggle),
  // ensure activeTab is still valid. If not, fall back to defaultTab or first visible.
  useEffect(() => {
    if (visibleIds.length > 0 && !visibleIds.includes(activeTab)) {
      setActiveTab(defaultTab && visibleIds.includes(defaultTab) ? defaultTab : visibleIds[0]);
    }
  }, [visibleIds, activeTab, defaultTab]);

  const handleTabClick = useCallback(
    (tabId: string) => () => {
      setActiveTab(tabId);
    },
    []
  );

  const activeContent = visibleTabs.find((t) => t.id === activeTab)?.content;

  return (
    <div class={styles.container}>
      <div class={styles.iconStrip}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            class={`${styles.iconBtn} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={handleTabClick(tab.id)}
            title={tab.label}
            type="button"
            aria-label={tab.label}
          >
            {tab.icon}
          </button>
        ))}
      </div>
      <div class={styles.content}>{activeContent}</div>
    </div>
  );
}