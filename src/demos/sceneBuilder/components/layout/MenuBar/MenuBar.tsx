import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import styles from './MenuBar.module.css';

export interface MenuAction {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuAction[];
  onClick?: () => void;
}

export interface MenuDefinition {
  id: string;
  label: string;
  items: MenuAction[];
}

export type AppTab = 'editor' | 'materials';

export interface MenuBarProps {
  menus: MenuDefinition[];
  title?: string;
  fps?: number;
  drawCalls?: number;
  activeTab?: AppTab;
  onTabChange?: (tab: AppTab) => void;
}

interface SubmenuState {
  menuId: string | null;
  path: string[];
}

export function MenuBar({ menus, title = 'Pyro Engine', fps, drawCalls, activeTab = 'editor', onTabChange }: MenuBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [hoverPath, setHoverPath] = useState<string[]>([]);
  const menuBarRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setHoverPath([]);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  const handleMenuClick = useCallback((menuId: string) => {
    setOpenMenu((prev) => (prev === menuId ? null : menuId));
    setHoverPath([]);
  }, []);

  const handleActionClick = useCallback((action: MenuAction) => {
    if (action.disabled || action.submenu) return;
    action.onClick?.();
    setOpenMenu(null);
    setHoverPath([]);
  }, []);

  const handleSubmenuHover = useCallback((path: string[]) => {
    setHoverPath(path);
  }, []);

  const renderMenuItems = (items: MenuAction[], path: string[] = []) => {
    return items.map((item, index) => {
      if (item.separator) {
        return <div key={`sep-${index}`} class={styles.separator} />;
      }

      const currentPath = [...path, item.id];
      const hasSubmenu = item.submenu && item.submenu.length > 0;
      const isSubmenuOpen = hoverPath.length >= currentPath.length &&
        currentPath.every((p, i) => hoverPath[i] === p);

      return (
        <div
          key={item.id}
          class={`${styles.menuItem} ${hasSubmenu ? styles.hasSubmenu : ''} ${item.disabled ? styles.disabled : ''}`}
          onMouseEnter={() => hasSubmenu && handleSubmenuHover(currentPath)}
          onClick={() => !hasSubmenu && handleActionClick(item)}
        >
          <span class={styles.itemLabel}>
            {item.checked !== undefined && (
              <span class={styles.checkMark}>{item.checked ? '✓' : ' '}</span>
            )}
            {item.label}
          </span>
          {item.shortcut && <span class={styles.shortcut}>{item.shortcut}</span>}
          {hasSubmenu && <span class={styles.submenuArrow}>▶</span>}

          {hasSubmenu && isSubmenuOpen && (
            <div class={styles.submenu}>
              {renderMenuItems(item.submenu!, currentPath)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div class={styles.menuBar} ref={menuBarRef}>
      {/* Left section: Title + Menu buttons */}
      <div class={styles.leftSection}>
        <span class={styles.title}>{title}</span>
        <div class={styles.menuSection}>
          {menus.map((menu) => (
            <div
              key={menu.id}
              class={`${styles.menuButton} ${openMenu === menu.id ? styles.open : ''}`}
            >
              <button onClick={() => handleMenuClick(menu.id)}>{menu.label}</button>
              {openMenu === menu.id && (
                <div class={styles.dropdown}>{renderMenuItems(menu.items)}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Center section: Tab buttons */}
      <div class={styles.tabSection}>
        <button
          class={`${styles.tabButton} ${activeTab === 'editor' ? styles.tabActive : ''}`}
          onClick={() => onTabChange?.('editor')}
        >
          Editor
        </button>
        <button
          class={`${styles.tabButton} ${activeTab === 'materials' ? styles.tabActive : ''}`}
          onClick={() => onTabChange?.('materials')}
        >
          Materials
        </button>
      </div>

      {/* Right section: Stats display */}
      <div class={styles.fpsSection}>
        {fps !== undefined && (
          <span class={styles.fps}>{fps} FPS</span>
        )}
        {drawCalls !== undefined && (
          <span class={styles.drawCalls}>{drawCalls} DC</span>
        )}
      </div>
    </div>
  );
}
