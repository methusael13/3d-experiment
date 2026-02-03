import { ComponentChildren } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import styles from './Tabs.module.css';

export interface Tab {
  id: string;
  label: string;
  content: ComponentChildren;
  visible?: boolean;
}

export interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function Tabs({ tabs, defaultTab }: TabsProps) {
  const visibleTabs = tabs.filter((t) => t.visible !== false);
  const [activeTab, setActiveTab] = useState(defaultTab || visibleTabs[0]?.id);

  const handleTabClick = useCallback(
    (tabId: string) => () => {
      setActiveTab(tabId);
    },
    []
  );

  const activeContent = visibleTabs.find((t) => t.id === activeTab)?.content;

  return (
    <div class={styles.container}>
      <div class={styles.tabList}>
        {visibleTabs.map((tab) => (
          <button
            key={tab.id}
            class={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={handleTabClick(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div class={styles.content}>{activeContent}</div>
    </div>
  );
}
