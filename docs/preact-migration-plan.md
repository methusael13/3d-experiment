# SceneBuilder UI Migration: Preact + CSS Modules

## Overview

This document outlines the migration plan for the SceneBuilder demo from raw HTML/JavaScript/CSS to a component-based architecture using **Preact** with **CSS Modules**.

### Goals
- Break down monolithic UI code into reusable components
- Improve maintainability and reduce boilerplate
- Enable incremental development and testing
- Maintain full compatibility with existing WebGL/WebGPU rendering logic

### Technology Choices
- **Preact** (~3KB) - React-compatible, minimal footprint
- **CSS Modules** - Scoped styles, easy migration from existing CSS
- **TypeScript** - Full type safety for components and props

---

## Current Architecture Analysis

### Pain Points

| Issue | Current State | Impact |
|-------|--------------|--------|
| Monolithic styles | `styles.ts` - ~700 lines of CSS in one string | Hard to maintain, no scoping |
| Template strings | HTML embedded as raw strings | No syntax highlighting, error-prone |
| Manual DOM caching | `cacheDOM()` with 40+ querySelector calls | Brittle, verbose |
| No component reuse | Slider pattern repeated 40+ times | Code duplication |
| Callback chains | 15+ callbacks passed through PanelContext | Complex data flow |

### Current Files to Migrate

```
src/demos/sceneBuilder/
├── SceneBuilder.ts          # ~700 lines - Main orchestrator
├── styles.ts                # ~700 lines - All CSS
├── componentPanels/
│   ├── panelContext.ts      # ~200 lines - Shared context type
│   ├── ObjectsPanel.ts      # ~200 lines
│   ├── ObjectPanel.ts       # ~500 lines
│   ├── TerrainPanel.ts      # ~950 lines - Largest panel
│   ├── EnvironmentPanel.ts  # ~400 lines
│   ├── MaterialPanel.ts     # ~200 lines
│   ├── RenderingPanel.ts    # ~300 lines
│   └── index.ts
└── [Keep unchanged]
    ├── Viewport.ts          # WebGL/WebGPU rendering
    ├── lightingManager.ts   # Lighting logic
    ├── wind.ts              # Wind simulation
    ├── InputManager.ts      # Input handling
    └── gizmos/              # Transform gizmos
```

---

## Target Architecture

### File Structure

```
src/demos/sceneBuilder/
├── components/
│   ├── ui/                         # Shared UI primitives
│   │   ├── Slider/
│   │   │   ├── Slider.tsx
│   │   │   ├── Slider.module.css
│   │   │   └── index.ts
│   │   ├── Checkbox/
│   │   │   ├── Checkbox.tsx
│   │   │   └── Checkbox.module.css
│   │   ├── ColorPicker/
│   │   │   ├── ColorPicker.tsx
│   │   │   └── ColorPicker.module.css
│   │   ├── Select/
│   │   │   ├── Select.tsx
│   │   │   └── Select.module.css
│   │   ├── VectorInput/
│   │   │   ├── VectorInput.tsx
│   │   │   └── VectorInput.module.css
│   │   ├── Section/
│   │   │   ├── Section.tsx
│   │   │   └── Section.module.css
│   │   ├── Panel/
│   │   │   ├── Panel.tsx
│   │   │   └── Panel.module.css
│   │   ├── Tabs/
│   │   │   ├── Tabs.tsx
│   │   │   └── Tabs.module.css
│   │   └── index.ts                # Re-exports all UI components
│   │
│   ├── panels/                     # Application panels
│   │   ├── ObjectsPanel/
│   │   │   ├── ObjectsPanel.tsx
│   │   │   ├── ObjectListItem.tsx
│   │   │   └── ObjectsPanel.module.css
│   │   ├── ObjectPanel/
│   │   │   ├── ObjectPanel.tsx
│   │   │   ├── TransformTab.tsx
│   │   │   ├── EditTab.tsx
│   │   │   ├── TerrainTab.tsx
│   │   │   ├── ModifiersTab.tsx
│   │   │   └── ObjectPanel.module.css
│   │   ├── TerrainPanel/
│   │   │   ├── TerrainPanel.tsx
│   │   │   ├── NoiseSection.tsx
│   │   │   ├── ErosionSection.tsx
│   │   │   ├── MaterialSection.tsx
│   │   │   ├── WaterSection.tsx
│   │   │   └── TerrainPanel.module.css
│   │   ├── EnvironmentPanel/
│   │   │   ├── EnvironmentPanel.tsx
│   │   │   ├── LightingTab.tsx
│   │   │   ├── ShadowsTab.tsx
│   │   │   ├── WindTab.tsx
│   │   │   └── EnvironmentPanel.module.css
│   │   ├── MaterialPanel/
│   │   │   ├── MaterialPanel.tsx
│   │   │   └── MaterialPanel.module.css
│   │   ├── RenderingPanel/
│   │   │   ├── RenderingPanel.tsx
│   │   │   └── RenderingPanel.module.css
│   │   └── index.ts
│   │
│   ├── MenuBar/
│   │   ├── MenuBar.tsx
│   │   ├── MenuItem.tsx
│   │   └── MenuBar.module.css
│   │
│   └── ViewportWrapper/
│       ├── ViewportWrapper.tsx
│       └── ViewportWrapper.module.css
│
├── context/
│   ├── SceneContext.tsx            # Scene, selection, transforms
│   ├── UIContext.tsx               # Gizmo mode, panel state
│   └── LightingContext.tsx         # Lighting state
│
├── hooks/
│   ├── useScene.ts                 # Scene operations
│   ├── useSelection.ts             # Selection state
│   ├── useLighting.ts              # Lighting controls
│   ├── useWind.ts                  # Wind settings
│   └── useTerrain.ts               # Terrain operations
│
├── styles/
│   ├── variables.css               # CSS custom properties (theme)
│   └── layout.module.css           # Main layout styles
│
├── SceneBuilder.tsx                # Root Preact component
├── SceneBuilder.module.css
├── index.ts                        # Entry point (mounts Preact app)
│
└── [Keep unchanged - Non-UI logic]
    ├── Viewport.ts
    ├── lightingManager.ts
    ├── wind.ts
    ├── InputManager.ts
    ├── FPSCameraController.ts
    ├── ShaderDebugPanel.ts
    ├── shaderManager.ts
    └── gizmos/
```

---

## Phase 1: Setup (Estimated: 1 day)

### 1.1 Install Dependencies

```bash
npm install preact @preact/preset-vite
npm install -D @types/css-modules
```

### 1.2 Update Vite Configuration

**vite.config.ts:**
```typescript
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
});
```

### 1.3 Update TypeScript Configuration

**tsconfig.json additions:**
```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "moduleResolution": "bundler"
  }
}
```

### 1.4 Create CSS Module Type Declarations

**src/css-modules.d.ts:**
```typescript
declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}
```

### 1.5 Create Theme Variables

**src/demos/sceneBuilder/styles/variables.css:**
```css
:root {
  /* Background colors */
  --sb-bg-dark: #1a1a1a;
  --sb-bg-panel: #2a2a2a;
  --sb-bg-input: #333;
  --sb-bg-hover: #444;
  
  /* Text colors */
  --sb-text-primary: #f0f0f0;
  --sb-text-secondary: #ccc;
  --sb-text-muted: #888;
  --sb-text-disabled: #666;
  
  /* Accent colors */
  --sb-accent: #ff6666;
  --sb-accent-hover: #ff8888;
  --sb-accent-secondary: #ff9966;
  
  /* Border colors */
  --sb-border: #555;
  --sb-border-hover: #666;
  
  /* Spacing */
  --sb-spacing-xs: 4px;
  --sb-spacing-sm: 8px;
  --sb-spacing-md: 12px;
  --sb-spacing-lg: 16px;
  
  /* Border radius */
  --sb-radius-sm: 3px;
  --sb-radius-md: 4px;
  --sb-radius-lg: 6px;
  
  /* Font sizes */
  --sb-font-xs: 10px;
  --sb-font-sm: 11px;
  --sb-font-md: 12px;
  --sb-font-lg: 13px;
}
```

---

## Phase 2: UI Primitives (Estimated: 2-3 days)

### 2.1 Slider Component

The Slider is the most frequently used component (~40 instances).

**components/ui/Slider/Slider.tsx:**
```tsx
import { h } from 'preact';
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
  const handleChange = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    onChange(parseFloat(target.value));
  }, [onChange]);

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
```

**components/ui/Slider/Slider.module.css:**
```css
.container {
  margin-bottom: 5px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1px;
}

.label {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-muted);
}

.value {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-secondary);
  min-width: 30px;
  text-align: right;
}

.slider {
  width: 100%;
  margin: 2px 0;
  accent-color: var(--sb-accent);
  height: 12px;
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

.slider::-webkit-slider-runnable-track {
  height: 4px;
  background: var(--sb-bg-hover);
  border-radius: 2px;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--sb-accent);
  cursor: pointer;
  margin-top: -3px;
}

.slider:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
```

### 2.2 Checkbox Component

**components/ui/Checkbox/Checkbox.tsx:**
```tsx
import { h } from 'preact';
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
  const handleChange = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    onChange(target.checked);
  }, [onChange]);

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
```

### 2.3 ColorPicker Component

**components/ui/ColorPicker/ColorPicker.tsx:**
```tsx
import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import styles from './ColorPicker.module.css';

export interface ColorPickerProps {
  label: string;
  value: [number, number, number]; // RGB 0-1
  onChange: (color: [number, number, number]) => void;
}

function rgbToHex(rgb: [number, number, number]): string {
  const toHex = (n: number) => {
    const h = Math.round(n * 255).toString(16);
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

export function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  const handleChange = useCallback((e: Event) => {
    const target = e.target as HTMLInputElement;
    onChange(hexToRgb(target.value));
  }, [onChange]);

  return (
    <div class={styles.container}>
      <label class={styles.label}>{label}</label>
      <input
        type="color"
        class={styles.input}
        value={rgbToHex(value)}
        onInput={handleChange}
      />
    </div>
  );
}
```

### 2.4 VectorInput Component

**components/ui/VectorInput/VectorInput.tsx:**
```tsx
import { h } from 'preact';
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
  const handleAxisChange = useCallback((axis: 0 | 1 | 2) => (e: Event) => {
    const target = e.target as HTMLInputElement;
    const newValue = [...value] as [number, number, number];
    newValue[axis] = parseFloat(target.value) || 0;
    onChange(newValue);
  }, [value, onChange]);

  return (
    <div class={styles.container}>
      <div class={styles.header}>
        <label class={styles.label}>{label}</label>
        {onReset && (
          <button class={styles.resetBtn} onClick={onReset} title="Reset">
            ⟲
          </button>
        )}
      </div>
      <div class={styles.inputs}>
        <input
          type="number"
          class={styles.input}
          value={value[0].toFixed(2)}
          step={step}
          onInput={handleAxisChange(0)}
          placeholder="X"
          disabled={disabled}
        />
        <input
          type="number"
          class={styles.input}
          value={value[1].toFixed(2)}
          step={step}
          onInput={handleAxisChange(1)}
          placeholder="Y"
          disabled={disabled}
        />
        <input
          type="number"
          class={styles.input}
          value={value[2].toFixed(2)}
          step={step}
          onInput={handleAxisChange(2)}
          placeholder="Z"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
```

### 2.5 Section Component (Collapsible)

**components/ui/Section/Section.tsx:**
```tsx
import { h, ComponentChildren } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import styles from './Section.module.css';

export interface SectionProps {
  title: string;
  children: ComponentChildren;
  defaultCollapsed?: boolean;
}

export function Section({ title, children, defaultCollapsed = false }: SectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => !prev);
  }, []);

  return (
    <div class={`${styles.section} ${collapsed ? styles.collapsed : ''}`}>
      <h3 class={styles.title} onClick={toggleCollapsed}>
        {title}
      </h3>
      {!collapsed && <div class={styles.content}>{children}</div>}
    </div>
  );
}
```

### 2.6 Tabs Component

**components/ui/Tabs/Tabs.tsx:**
```tsx
import { h, ComponentChildren } from 'preact';
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
  const visibleTabs = tabs.filter(t => t.visible !== false);
  const [activeTab, setActiveTab] = useState(defaultTab || visibleTabs[0]?.id);

  const handleTabClick = useCallback((tabId: string) => () => {
    setActiveTab(tabId);
  }, []);

  const activeContent = visibleTabs.find(t => t.id === activeTab)?.content;

  return (
    <div class={styles.container}>
      <div class={styles.tabList}>
        {visibleTabs.map(tab => (
          <button
            key={tab.id}
            class={`${styles.tab} ${activeTab === tab.id ? styles.active : ''}`}
            onClick={handleTabClick(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div class={styles.content}>{activeContent}</div>
    </div>
  );
}
```

### 2.7 Panel Component

**components/ui/Panel/Panel.tsx:**
```tsx
import { h, ComponentChildren } from 'preact';
import styles from './Panel.module.css';

export interface PanelProps {
  title: string;
  children: ComponentChildren;
  visible?: boolean;
}

export function Panel({ title, children, visible = true }: PanelProps) {
  if (!visible) return null;

  return (
    <div class={styles.panel}>
      <h3 class={styles.title}>{title}</h3>
      <div class={styles.content}>{children}</div>
    </div>
  );
}
```

### 2.8 Select Component

**components/ui/Select/Select.tsx:**
```tsx
import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function Select({ label, value, options, onChange, disabled }: SelectProps) {
  const handleChange = useCallback((e: Event) => {
    const target = e.target as HTMLSelectElement;
    onChange(target.value);
  }, [onChange]);

  return (
    <div class={styles.container}>
      {label && <label class={styles.label}>{label}</label>}
      <select
        class={styles.select}
        value={value}
        onChange={handleChange}
        disabled={disabled}
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
```

---

## Phase 3: Context & Hooks (Estimated: 1 day)

### 3.1 SceneContext

**context/SceneContext.tsx:**
```tsx
import { h, createContext, ComponentChildren } from 'preact';
import { useContext, useState, useCallback, useMemo } from 'preact/hooks';
import type { Scene } from '../../../core/Scene';
import type { AnySceneObject } from '../../../core/sceneObjects';

interface SceneContextValue {
  scene: Scene | null;
  selectedIds: Set<string>;
  selectedObjects: AnySceneObject[];
  selectionCount: number;
  
  // Actions
  select: (id: string, additive?: boolean) => void;
  clearSelection: () => void;
  toggleSelectAll: () => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  
  // Object operations
  addPrimitive: (type: 'cube' | 'plane' | 'sphere') => void;
  addTerrain: () => Promise<void>;
  removeObject: (id: string) => void;
}

const SceneContext = createContext<SceneContextValue | null>(null);

export function SceneProvider({ 
  scene, 
  children 
}: { 
  scene: Scene | null; 
  children: ComponentChildren;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sync selection state with scene
  const syncSelection = useCallback(() => {
    if (scene) {
      setSelectedIds(new Set(scene.getSelectedIds()));
    }
  }, [scene]);

  const select = useCallback((id: string, additive = false) => {
    scene?.select(id, { additive });
    syncSelection();
  }, [scene, syncSelection]);

  const clearSelection = useCallback(() => {
    scene?.clearSelection();
    syncSelection();
  }, [scene, syncSelection]);

  // ... more actions

  const value = useMemo(() => ({
    scene,
    selectedIds,
    selectedObjects: scene?.getSelectedObjects() || [],
    selectionCount: selectedIds.size,
    select,
    clearSelection,
    toggleSelectAll: () => { scene?.toggleSelectAllObjects(); syncSelection(); },
    deleteSelected: () => { /* ... */ },
    duplicateSelected: () => { /* ... */ },
    addPrimitive: (type) => { /* ... */ },
    addTerrain: async () => { /* ... */ },
    removeObject: (id) => { /* ... */ },
  }), [scene, selectedIds, select, clearSelection]);

  return (
    <SceneContext.Provider value={value}>
      {children}
    </SceneContext.Provider>
  );
}

export function useScene() {
  const context = useContext(SceneContext);
  if (!context) {
    throw new Error('useScene must be used within SceneProvider');
  }
  return context;
}
```

### 3.2 UIContext

**context/UIContext.tsx:**
```tsx
import { h, createContext, ComponentChildren } from 'preact';
import { useContext, useState, useCallback, useMemo } from 'preact/hooks';
import type { GizmoMode, GizmoOrientation } from '../gizmos';

interface UIContextValue {
  gizmoMode: GizmoMode;
  gizmoOrientation: GizmoOrientation;
  viewportMode: 'solid' | 'wireframe';
  showGrid: boolean;
  showAxes: boolean;
  isExpanded: boolean;
  
  setGizmoMode: (mode: GizmoMode) => void;
  setGizmoOrientation: (orientation: GizmoOrientation) => void;
  setViewportMode: (mode: 'solid' | 'wireframe') => void;
  toggleGrid: () => void;
  toggleAxes: () => void;
  toggleExpanded: () => void;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider({ children }: { children: ComponentChildren }) {
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [gizmoOrientation, setGizmoOrientation] = useState<GizmoOrientation>('world');
  const [viewportMode, setViewportMode] = useState<'solid' | 'wireframe'>('solid');
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);

  const value = useMemo(() => ({
    gizmoMode,
    gizmoOrientation,
    viewportMode,
    showGrid,
    showAxes,
    isExpanded,
    setGizmoMode,
    setGizmoOrientation,
    setViewportMode,
    toggleGrid: () => setShowGrid(prev => !prev),
    toggleAxes: () => setShowAxes(prev => !prev),
    toggleExpanded: () => setIsExpanded(prev => !prev),
  }), [gizmoMode, gizmoOrientation, viewportMode, showGrid, showAxes, isExpanded]);

  return (
    <UIContext.Provider value={value}>
      {children}
    </UIContext.Provider>
  );
}

export function useUI() {
  const context = useContext(UIContext);
  if (!context) {
    throw new Error('useUI must be used within UIProvider');
  }
  return context;
}
```

### 3.3 Custom Hooks

**hooks/useSelection.ts:**
```typescript
import { useMemo } from 'preact/hooks';
import { useScene } from '../context/SceneContext';

export function useSelection() {
  const { scene, selectedIds, selectedObjects, selectionCount } = useScene();

  const firstSelected = useMemo(() => {
    return selectedObjects[0] || null;
  }, [selectedObjects]);

  const isSingleSelection = selectionCount === 1;
  const hasSelection = selectionCount > 0;

  return {
    selectedIds,
    selectedObjects,
    selectionCount,
    firstSelected,
    isSingleSelection,
    hasSelection,
  };
}
```

---

## Phase 4: Panel Migration (Estimated: 4-5 days)

### 4.1 ObjectsPanel

**components/panels/ObjectsPanel/ObjectsPanel.tsx:**
```tsx
import { h } from 'preact';
import { useScene } from '../../../context/SceneContext';
import { Panel } from '../../ui/Panel';
import { ObjectListItem } from './ObjectListItem';
import styles from './ObjectsPanel.module.css';

export function ObjectsPanel() {
  const { scene, selectedIds, select, clearSelection } = useScene();

  if (!scene) return null;

  const objects = scene.getAllObjects();

  const handleItemClick = (id: string, e: MouseEvent) => {
    select(id, e.shiftKey);
  };

  return (
    <Panel title="Objects">
      <ul class={styles.objectList}>
        {objects.map(obj => (
          <ObjectListItem
            key={obj.id}
            object={obj}
            selected={selectedIds.has(obj.id)}
            onClick={handleItemClick}
          />
        ))}
      </ul>
      <div class={styles.controls}>
        <button class={styles.importBtn}>Import Model...</button>
      </div>
    </Panel>
  );
}
```

### 4.2 ObjectPanel with Tabs

**components/panels/ObjectPanel/ObjectPanel.tsx:**
```tsx
import { h } from 'preact';
import { useMemo } from 'preact/hooks';
import { useSelection } from '../../../hooks/useSelection';
import { Panel } from '../../ui/Panel';
import { Tabs } from '../../ui/Tabs';
import { TransformTab } from './TransformTab';
import { EditTab } from './EditTab';
import { TerrainTab } from './TerrainTab';
import { ModifiersTab } from './ModifiersTab';

export function ObjectPanel() {
  const { hasSelection, firstSelected, isSingleSelection } = useSelection();

  const showEditTab = isSingleSelection && 
    (firstSelected as any)?.objectType === 'primitive';
  
  const showTerrainTab = isSingleSelection && 
    ((firstSelected as any)?.objectType === 'terrain' || 
     (firstSelected as any)?.objectType === 'gpu-terrain');

  const tabs = useMemo(() => [
    { id: 'transform', label: 'Transform', content: <TransformTab /> },
    { id: 'edit', label: 'Edit', content: <EditTab />, visible: showEditTab },
    { id: 'terrain', label: 'Terrain', content: <TerrainTab />, visible: showTerrainTab },
    { id: 'modifiers', label: 'Modifiers', content: <ModifiersTab /> },
  ], [showEditTab, showTerrainTab]);

  if (!hasSelection) return null;

  return (
    <Panel title="Object" visible={hasSelection}>
      <Tabs tabs={tabs} defaultTab="transform" />
    </Panel>
  );
}
```

### 4.3 TransformTab

**components/panels/ObjectPanel/TransformTab.tsx:**
```tsx
import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import { useSelection } from '../../../hooks/useSelection';
import { useScene } from '../../../context/SceneContext';
import { useUI } from '../../../context/UIContext';
import { VectorInput } from '../../ui/VectorInput';
import styles from './ObjectPanel.module.css';

export function TransformTab() {
  const { firstSelected, isSingleSelection, selectionCount } = useSelection();
  const { scene } = useScene();
  const { gizmoMode, gizmoOrientation, setGizmoMode, setGizmoOrientation } = useUI();

  const handlePositionChange = useCallback((value: [number, number, number]) => {
    if (!firstSelected || !scene) return;
    firstSelected.position = value;
    scene.updateObjectTransform(firstSelected.id);
  }, [firstSelected, scene]);

  const handleRotationChange = useCallback((value: [number, number, number]) => {
    if (!firstSelected || !scene) return;
    firstSelected.rotation = value;
    scene.updateObjectTransform(firstSelected.id);
  }, [firstSelected, scene]);

  const handleScaleChange = useCallback((value: [number, number, number]) => {
    if (!firstSelected || !scene) return;
    firstSelected.scale = value.map(v => Math.max(0.01, v)) as [number, number, number];
    scene.updateObjectTransform(firstSelected.id);
  }, [firstSelected, scene]);

  if (!firstSelected) return null;

  return (
    <div class={styles.transformTab}>
      {/* Gizmo Mode Toggle */}
      <div class={styles.gizmoToggle}>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'translate' ? styles.active : ''}`}
          onClick={() => setGizmoMode('translate')}
          title="Translate (T)"
        >
          T
        </button>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'rotate' ? styles.active : ''}`}
          onClick={() => setGizmoMode('rotate')}
          title="Rotate (R)"
        >
          R
        </button>
        <button
          class={`${styles.gizmoBtn} ${gizmoMode === 'scale' ? styles.active : ''}`}
          onClick={() => setGizmoMode('scale')}
          title="Scale (S)"
        >
          S
        </button>
        <span class={styles.separator}>|</span>
        <button
          class={`${styles.gizmoBtn} ${styles.orientationBtn} ${gizmoOrientation === 'world' ? styles.active : ''}`}
          onClick={() => setGizmoOrientation('world')}
        >
          W
        </button>
        <button
          class={`${styles.gizmoBtn} ${styles.orientationBtn} ${gizmoOrientation === 'local' ? styles.active : ''}`}
          onClick={() => setGizmoOrientation('local')}
        >
          L
        </button>
      </div>

      {/* Name Input */}
      <div class={styles.nameGroup}>
        <label>Name</label>
        <input
          type="text"
          class={styles.nameInput}
          value={isSingleSelection ? firstSelected.name : `${selectionCount} objects`}
          disabled={!isSingleSelection}
          onInput={(e) => {
            if (isSingleSelection && firstSelected) {
              (firstSelected as any).name = (e.target as HTMLInputElement).value;
            }
          }}
        />
      </div>

      {/* Transform Inputs */}
      <VectorInput
        label="Position"
        value={firstSelected.position as [number, number, number]}
        onChange={handlePositionChange}
        onReset={() => handlePositionChange([0, 0, 0])}
        disabled={!isSingleSelection}
      />
      <VectorInput
        label="Rotation (°)"
        value={firstSelected.rotation as [number, number, number]}
        onChange={handleRotationChange}
        step={5}
        onReset={() => handleRotationChange([0, 0, 0])}
        disabled={!isSingleSelection}
      />
      <VectorInput
        label="Scale"
        value={firstSelected.scale as [number, number, number]}
        onChange={handleScaleChange}
        onReset={() => handleScaleChange([1, 1, 1])}
        disabled={!isSingleSelection}
      />

      {/* Delete Button */}
      <button class={styles.deleteBtn}>Delete Object</button>
    </div>
  );
}
```

### 4.4 TerrainPanel (Largest Panel)

The TerrainPanel is the largest panel (~950 lines). It should be broken into sections:

**components/panels/TerrainPanel/TerrainPanel.tsx:**
```tsx
import { h } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import { Panel } from '../../ui/Panel';
import { Select } from '../../ui/Select';
import { NoiseSection } from './NoiseSection';
import { ErosionSection } from './ErosionSection';
import { MaterialSection } from './MaterialSection';
import { WaterSection } from './WaterSection';
import styles from './TerrainPanel.module.css';

interface TerrainPanelProps {
  terrain: any; // TerrainObject | TerrainManager
  onBoundsChanged?: (worldSize: number, heightScale: number) => void;
  onWaterConfigChange?: (config: any) => void;
}

const PRESETS = [
  { value: 'default', label: 'Default' },
  { value: 'rolling-hills', label: 'Rolling Hills' },
  { value: 'alpine-mountains', label: 'Alpine Mountains' },
  { value: 'desert-dunes', label: 'Desert Dunes' },
  { value: 'rocky-badlands', label: 'Rocky Badlands' },
  { value: 'volcanic-island', label: 'Volcanic Island' },
];

const RESOLUTIONS = [
  { value: '64', label: '64×64 (Fast)' },
  { value: '128', label: '128×128' },
  { value: '256', label: '256×256' },
  { value: '512', label: '512×512' },
  { value: '1024', label: '1024×1024' },
  { value: '2048', label: '2048×2048 (High)' },
  { value: '4096', label: '4096×4096 (Ultra)' },
];

export function TerrainPanel({ terrain, onBoundsChanged, onWaterConfigChange }: TerrainPanelProps) {
  const [preset, setPreset] = useState('default');
  const [resolution, setResolution] = useState('256');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');

  const handleUpdate = useCallback(async () => {
    if (!terrain) return;
    
    setIsGenerating(true);
    setProgress(0);
    
    try {
      // Terrain regeneration logic here
      await terrain.regenerate?.((info: any) => {
        setProgress(info.progress * 100);
        setProgressText(info.stage);
      });
    } finally {
      setIsGenerating(false);
    }
  }, [terrain]);

  if (!terrain) return null;

  return (
    <div class={styles.container}>
      {/* Preset Selection */}
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Preset</div>
        <div class={styles.presetRow}>
          <Select
            value={preset}
            options={PRESETS}
            onChange={setPreset}
          />
          <button class={styles.resetBtn} title="Reset to preset values">
            ↺ Reset
          </button>
        </div>
      </div>

      {/* Resolution */}
      <div class={styles.section}>
        <div class={styles.sectionTitle}>Resolution</div>
        <Select
          value={resolution}
          options={RESOLUTIONS}
          onChange={setResolution}
        />
      </div>

      {/* Noise Section */}
      <NoiseSection terrain={terrain} />

      {/* Erosion Section */}
      <ErosionSection terrain={terrain} />

      {/* Material Section */}
      <MaterialSection terrain={terrain} />

      {/* Water Section */}
      <WaterSection 
        terrain={terrain} 
        onConfigChange={onWaterConfigChange}
      />

      {/* Update Button */}
      <button 
        class={styles.updateBtn}
        onClick={handleUpdate}
        disabled={isGenerating}
      >
        🔄 Update Terrain
      </button>

      {/* Progress Bar */}
      {isGenerating && (
        <div class={styles.progressContainer}>
          <div class={styles.progressBar}>
            <div 
              class={styles.progressFill} 
              style={{ width: `${progress}%` }}
            />
          </div>
          <div class={styles.progressText}>{progressText}</div>
        </div>
      )}
    </div>
  );
}
```

---

## Phase 5: Layout & Root Component (Estimated: 1-2 days)

### 5.1 MenuBar Component

**components/MenuBar/MenuBar.tsx:**
```tsx
import { h } from 'preact';
import { useState, useCallback } from 'preact/hooks';
import { useUI } from '../../context/UIContext';
import { useScene } from '../../context/SceneContext';
import { MenuItem } from './MenuItem';
import styles from './MenuBar.module.css';

export function MenuBar() {
  const { 
    viewportMode, setViewportMode, 
    showGrid, showAxes, 
    toggleGrid, toggleAxes,
    toggleExpanded 
  } = useUI();
  const { addPrimitive, addTerrain } = useScene();

  return (
    <div class={styles.menuBar}>
      {/* File Menu */}
      <MenuItem label="File">
        <button onClick={() => {}}>Load Scene</button>
        <button onClick={() => {}}>Save Scene</button>
      </MenuItem>

      {/* Scene Menu */}
      <MenuItem label="Scene">
        <MenuItem label="Add" submenu>
          <MenuItem label="Shapes" submenu>
            <button onClick={() => addPrimitive('cube')}>Cube</button>
            <button onClick={() => addPrimitive('plane')}>Plane</button>
            <button onClick={() => addPrimitive('sphere')}>UV Sphere</button>
          </MenuItem>
          <hr />
          <button onClick={() => addTerrain()}>Terrain</button>
        </MenuItem>
        <hr />
        <button>Group Selection <span>⌘G</span></button>
        <button>Ungroup <span>⌘⇧G</span></button>
      </MenuItem>

      {/* View Menu */}
      <MenuItem label="View">
        <MenuItem label="Viewport" submenu>
          <button onClick={() => setViewportMode('solid')}>
            {viewportMode === 'solid' ? '✓ ' : '  '}Solid View
          </button>
          <button onClick={() => setViewportMode('wireframe')}>
            {viewportMode === 'wireframe' ? '✓ ' : '  '}Wireframe View
          </button>
          <hr />
          <button onClick={toggleGrid}>
            {showGrid ? '✓ ' : '  '}Show Grid
          </button>
          <button onClick={toggleAxes}>
            {showAxes ? '✓ ' : '  '}Show Axes
          </button>
        </MenuItem>
        <hr />
        <button onClick={toggleExpanded}>Expand View</button>
      </MenuItem>

      {/* Lighting Menu */}
      <MenuItem label="Lighting">
        <button>Sun Mode</button>
        <button>HDR Mode</button>
      </MenuItem>
    </div>
  );
}
```

### 5.2 SceneBuilder Root Component

**SceneBuilder.tsx:**
```tsx
import { h, render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { SceneProvider } from './context/SceneContext';
import { UIProvider } from './context/UIContext';
import { MenuBar } from './components/MenuBar/MenuBar';
import { ObjectsPanel } from './components/panels/ObjectsPanel/ObjectsPanel';
import { ObjectPanel } from './components/panels/ObjectPanel/ObjectPanel';
import { EnvironmentPanel } from './components/panels/EnvironmentPanel/EnvironmentPanel';
import { RenderingPanel } from './components/panels/RenderingPanel/RenderingPanel';
import { MaterialPanel } from './components/panels/MaterialPanel/MaterialPanel';
import { Viewport } from './Viewport'; // Keep existing
import { createScene, type Scene } from '../../core/Scene';
import styles from './SceneBuilder.module.css';
import './styles/variables.css';

export interface SceneBuilderProps {
  container: HTMLElement;
  width?: number;
  height?: number;
  onFps?: (fps: number) => void;
}

function SceneBuilderApp({ width, height, onFps }: Omit<SceneBuilderProps, 'container'>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);

  // Initialize viewport and scene
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const vp = new Viewport(canvas, { width, height, onFps });
    if (!vp.init()) return;

    const gl = vp.getGL()!;
    const sc = createScene(gl, vp.getSceneGraph());

    setViewport(vp);
    setScene(sc);

    return () => {
      vp.destroy();
      sc.destroy();
    };
  }, [width, height, onFps]);

  return (
    <UIProvider>
      <SceneProvider scene={scene}>
        <div class={styles.container}>
          <MenuBar />
          
          <div class={styles.layout}>
            {/* Left Sidebar */}
            <div class={styles.sidebarLeft}>
              <ObjectsPanel />
              <ObjectPanel />
            </div>

            {/* Viewport */}
            <div class={styles.viewport}>
              <canvas ref={canvasRef} />
            </div>

            {/* Right Sidebar */}
            <div class={styles.sidebarRight}>
              <EnvironmentPanel />
              <RenderingPanel />
              <MaterialPanel />
            </div>
          </div>
        </div>
      </SceneProvider>
    </UIProvider>
  );
}

/**
 * Mount the SceneBuilder app to a container
 */
export function createSceneBuilder(props: SceneBuilderProps): () => void {
  const { container, ...rest } = props;
  
  render(<SceneBuilderApp {...rest} />, container);
  
  return () => {
    render(null, container);
  };
}
```

### 5.3 Entry Point

**index.ts:**
```typescript
export { createSceneBuilder, type SceneBuilderProps } from './SceneBuilder';
```

---

## Phase 6: Integration & Cleanup (Estimated: 1-2 days)

### 6.1 Wiring Up Existing Logic

The key is that all the non-UI logic stays the same:

- **Viewport.ts** - Keep unchanged, just accessed via ref
- **lightingManager.ts** - Wrap with `useLighting()` hook
- **wind.ts** - Wrap with `useWind()` hook
- **InputManager.ts** - Keep unchanged
- **gizmos/** - Keep unchanged

### 6.2 Migration Checklist

- [ ] Replace `SceneBuilder.ts` class with `SceneBuilder.tsx` component
- [ ] Remove `styles.ts` (migrated to CSS Modules)
- [ ] Remove old `componentPanels/*.ts` files
- [ ] Update imports in `main.js` or entry point
- [ ] Test all functionality:
  - [ ] Object selection
  - [ ] Transform gizmos
  - [ ] Terrain generation
  - [ ] Lighting controls
  - [ ] Material editing
  - [ ] Scene save/load

### 6.3 Files to Delete After Migration

```
src/demos/sceneBuilder/
├── [DELETE] SceneBuilder.ts
├── [DELETE] styles.ts
├── componentPanels/
│   ├── [DELETE] ObjectsPanel.ts
│   ├── [DELETE] ObjectPanel.ts
│   ├── [DELETE] TerrainPanel.ts
│   ├── [DELETE] EnvironmentPanel.ts
│   ├── [DELETE] MaterialPanel.ts
│   ├── [DELETE] RenderingPanel.ts
│   ├── [DELETE] panelContext.ts
│   └── [DELETE] index.ts
```

---

## Testing Strategy

### Unit Tests (Optional)
- Test UI components with Preact Testing Library
- Test hooks with `@testing-library/preact-hooks`

### Manual Testing Checklist
1. **Selection**: Click objects, Shift+click multi-select, click background to deselect
2. **Transforms**: Move/rotate/scale with gizmos, edit values in panel
3. **Terrain**: Generate terrain, adjust parameters, preview updates
4. **Lighting**: Switch modes, adjust sun direction, load HDR
5. **Materials**: Edit primitive materials, color pickers work
6. **Scene**: Save scene, load scene, state restored correctly

---

## Timeline Summary

| Phase | Duration | Description |
|-------|----------|-------------|
| 1. Setup | 1 day | Dependencies, config, project structure |
| 2. UI Primitives | 2-3 days | 8 reusable components |
| 3. Context & Hooks | 1 day | State management |
| 4. Panel Migration | 4-5 days | All 6 panels |
| 5. Layout & Root | 1-2 days | MenuBar, SceneBuilder root |
| 6. Integration | 1-2 days | Wire up, test, cleanup |
| **Total** | **10-14 days** | |

---

## Benefits After Migration

1. **~60% less code** in UI layer (reusable components)
2. **Scoped styles** - no more CSS conflicts
3. **Type-safe props** - catch errors at compile time
4. **Easier testing** - components can be tested in isolation
5. **Better DX** - JSX syntax highlighting, hot reload
6. **Incremental updates** - modify one component without touching others

---

## Appendix: CSS Module File Templates

### Checkbox.module.css
```css
.container {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  margin-bottom: 8px;
  font-size: var(--sb-font-sm);
}

.checkbox {
  width: 12px;
  height: 12px;
  accent-color: var(--sb-accent);
}

.label {
  color: var(--sb-text-secondary);
}
```

### ColorPicker.module.css
```css
.container {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.label {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-muted);
  min-width: 80px;
}

.input {
  width: 36px;
  height: 24px;
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-sm);
  background: none;
  cursor: pointer;
  padding: 0;
}
```

### VectorInput.module.css
```css
.container {
  margin-bottom: 6px;
}

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.label {
  font-size: var(--sb-font-xs);
  color: var(--sb-text-muted);
}

.resetBtn {
  padding: 2px 6px;
  background: transparent;
  color: var(--sb-text-disabled);
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-sm);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.resetBtn:hover {
  background: var(--sb-bg-hover);
  color: var(--sb-text-primary);
}

.inputs {
  display: flex;
  gap: 4px;
}

.input {
  flex: 1;
  padding: 4px 6px;
  background: var(--sb-bg-input);
  border: 1px solid var(--sb-border);
  border-radius: var(--sb-radius-sm);
  color: var(--sb-text-primary);
  font-family: monospace;
  font-size: var(--sb-font-xs);
  width: 50px;
}

.input:focus {
  outline: none;
  border-color: var(--sb-accent);
}
```

### Panel.module.css
```css
.panel {
  background: var(--sb-bg-panel);
  border-radius: var(--sb-radius-lg);
  padding: 10px 12px;
  margin-bottom: var(--sb-spacing-lg);
}

.title {
  font-size: var(--sb-font-sm);
  color: var(--sb-text-muted);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.content {
  /* Content styles */
}
```

### Tabs.module.css
```css
.container {
  width: 100%;
}

.tabList {
  display: flex;
  gap: 0;
  margin-bottom: 8px;
  border-radius: var(--sb-radius-sm);
  overflow: hidden;
  border: 1px solid var(--sb-border);
}

.tab {
  flex: 1;
  padding: 6px 0;
  background: var(--sb-bg-input);
  color: var(--sb-text-muted);
  border: none;
  cursor: pointer;
  font-size: var(--sb-font-xs);
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition: all 0.15s;
}

.tab:not(:last-child) {
  border-right: 1px solid var(--sb-border);
}

.tab:hover {
  background: var(--sb-bg-hover);
  color: var(--sb-text-primary);
}

.tab.active {
  background: var(--sb-accent);
  color: #000;
}

.content {
  max-height: 350px;
  overflow-y: auto;
  padding-right: 4px;
}

.content::-webkit-scrollbar {
  width: 4px;
}

.content::-webkit-scrollbar-track {
  background: #222;
  border-radius: 2px;
}

.content::-webkit-scrollbar-thumb {
  background: var(--sb-border);
  border-radius: 2px;
}
```

---

## Notes

- This migration preserves all existing functionality
- WebGL/WebGPU rendering code is untouched
- The migration can be done incrementally if needed
- All keyboard shortcuts continue to work
- Scene save/load format remains compatible

## Progress state (missing integration)
### 1. __Menu Bar System__ (High Priority) [Done]

- File menu: Save Scene, Load Scene
- Edit menu: Group Selection, Ungroup
- View menu: Wireframe/Solid, Toggle Grid/Axes, Expand View, FPS Camera
- Add menu: Cube, Plane, UV Sphere, Terrain
- Currently SceneBuilderApp has NO menu bar at all

### 2. __Keyboard Shortcuts__ (High Priority) [Done]

- `T/R` - Gizmo mode switch
- `S` - Uniform scale mode
- `D` - Duplicate object
- `Delete/Backspace` - Delete selected
- `A` - Select all toggle
- `Ctrl+G / Ctrl+Shift+G` - Group/Ungroup
- `0,1,2,3` - Camera view presets

### 3. __Model/Asset Import__ (Medium Priority)

- GLB/OBJ file drop/import handler
- HDR file import for environment lighting

### 4. __Scene Serialization__ (Medium Priority)

- Save scene to JSON
- Load scene from JSON
- Currently SceneBuilderApp doesn't persist anything

### 5. __Per-Object Settings__ (Medium Priority)

- Wind settings per object (leaf/branch materials, influence, stiffness)
- Terrain blend settings per object
- These are stored in Maps in legacy code

### 6. __FPS Camera Mode__ (Low Priority)

- Walk on terrain in first-person mode
- Uses `FPSCameraController.ts`

### 7. __Viewport Toolbar__

- Solid/Wireframe mode toggle
- Grid/Axes visibility toggles

### 8. __ShaderDebugPanel__ (Low Priority)

- Developer tool for shader debugging

### 9. __Store Integration Gaps__

- `store.viewport` reference for some operations
- Wind manager not wired to store
- Transform gizmo callbacks not connected

