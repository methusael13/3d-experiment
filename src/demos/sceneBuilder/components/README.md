# SceneBuilder Components

This directory contains the new Preact-based UI component system for the SceneBuilder demo.

## Architecture Overview

The component system follows a modular architecture:

```
components/
├── styles/
│   └── variables.css       # CSS custom properties (design tokens)
├── ui/                     # Reusable UI primitives
│   ├── Slider/
│   ├── Checkbox/
│   ├── ColorPicker/
│   ├── Select/
│   ├── Section/
│   ├── VectorInput/
│   ├── Panel/
│   └── Tabs/
├── panels/                 # Full panel components
│   ├── EnvironmentPanel/
│   ├── ObjectsPanel/
│   ├── ObjectPanel/
│   ├── MaterialPanel/
│   └── RenderingPanel/
└── index.ts               # Main exports
```

## UI Primitives

All primitives are stateless, props-driven components:

| Component     | Purpose                                      |
|---------------|----------------------------------------------|
| `Slider`      | Number input with range slider               |
| `Checkbox`    | Boolean toggle with label                    |
| `ColorPicker` | RGB/Hex color selector                       |
| `Select`      | Dropdown select                              |
| `Section`     | Collapsible section with title               |
| `VectorInput` | 3D vector (X,Y,Z) input with reset button    |
| `Panel`       | Generic panel container with title           |
| `Tabs`        | Tab container with visibility support        |

## Panel Components

Panels are higher-level components that compose UI primitives:

| Panel             | Description                                    |
|-------------------|------------------------------------------------|
| `EnvironmentPanel`| Sky, lighting, fog, and wind controls          |
| `ObjectsPanel`    | Scene hierarchy list with add object menu      |
| `ObjectPanel`     | Transform, edit, and modifier controls         |
| `MaterialPanel`   | Material properties for selected objects       |
| `RenderingPanel`  | Shadow settings and WebGPU mode toggle         |

## Usage Example

```tsx
import { render } from 'preact';
import { EnvironmentPanel } from './components';

function App() {
  const [sunDirection, setSunDirection] = useState<[number, number, number]>([0.5, -0.8, 0.3]);
  
  return (
    <EnvironmentPanel
      activeTab="lighting"
      onTabChange={(tab) => console.log(tab)}
      sunDirection={sunDirection}
      onSunDirectionChange={setSunDirection}
      // ... other props
    />
  );
}

render(<App />, document.getElementById('sidebar')!);
```

## CSS Variables

The design system uses CSS custom properties defined in `styles/variables.css`:

```css
/* Colors */
--sb-bg-panel: #2a2a2a;
--sb-bg-input: #333;
--sb-bg-hover: #3a3a3a;
--sb-accent: #4a90d9;
--sb-text-primary: #f0f0f0;
--sb-text-secondary: #ccc;
--sb-text-muted: #888;
--sb-border: #555;

/* Spacing */
--sb-radius-sm: 3px;
--sb-radius-lg: 6px;

/* Typography */
--sb-font-xs: 10px;
--sb-font-sm: 11px;
--sb-font-md: 12px;
```

## Migration Status

- [x] UI Primitives complete
- [x] EnvironmentPanel migrated
- [x] ObjectsPanel migrated
- [x] ObjectPanel migrated (with sub-tabs)
- [x] MaterialPanel migrated
- [x] RenderingPanel migrated
- [x] TerrainPanel migrated (with sub-components)
  - NoiseSection - seed, scale, octaves, domain warping, rotation
  - ErosionSection - hydraulic & thermal erosion
  - MaterialSection - colors and texture thresholds
  - WaterSection - WebGPU water rendering
  - DetailSection - procedural detail for close-up

## Integration Notes

The new component system is designed to coexist with the legacy DOM-based panels during the migration period. The legacy panels in `componentPanels/` can be gradually replaced with the new Preact components.

### Architecture

```
components/
├── styles/variables.css     # CSS custom properties (design tokens)
├── ui/                      # 8 reusable primitives
├── panels/                  # 7 panel components
│   ├── EnvironmentPanel/
│   ├── ObjectsPanel/
│   ├── ObjectPanel/
│   ├── MaterialPanel/
│   ├── RenderingPanel/
│   └── TerrainPanel/       # 5 sub-sections
├── layout/
│   └── MenuBar/            # Nested menu with submenus
└── app/
    └── SidebarApp/         # Root app blueprint
```

### Integration Strategy

**Option 1: Gradual Panel Replacement (Recommended)**

Replace panels one at a time while keeping the existing SceneBuilder structure:

```typescript
// In SceneBuilder.ts init():
import { render } from 'preact';
import { EnvironmentPanel } from './components';

// Create a container for the Preact panel
const envPanelRoot = document.createElement('div');
const envContainer = this.container.querySelector('#environment-panel-container');
envContainer?.appendChild(envPanelRoot);

// Render the Preact panel
render(
  <EnvironmentPanel
    activeTab={this.envActiveTab}
    onTabChange={(tab) => this.setEnvActiveTab(tab)}
    lightMode={this.lightingManager.activeMode}
    sunDirection={this.lightingManager.sunLight.direction}
    // ... other props mapped from SceneBuilder state
  />,
  envPanelRoot
);
```

**Option 2: Full App Replacement**

Replace the entire UI with a single Preact app:

```typescript
// In SceneBuilder.ts:
import { render } from 'preact';
import { signal } from '@preact/signals';
import { SidebarApp, SidebarAppContext } from './components/app';

// Create reactive state
const context: SidebarAppContext = {
  objects: signal([]),
  selectedIds: signal([]),
  // ... map all state to signals
  
  // Map actions to SceneBuilder methods
  selectObject: (id, additive) => this.scene?.select(id, { additive }),
  addPrimitive: (type) => this.addPrimitive(type),
  saveScene: () => this.saveCurrentScene(),
  // ...
};

// Mount the app
const appRoot = document.createElement('div');
appRoot.className = 'scene-builder-preact-root';
this.container.innerHTML = '';
this.container.appendChild(appRoot);
render(<SidebarApp context={context} />, appRoot);
```

### Using Individual Components

All components are exported from the main index:

```typescript
import {
  // UI Primitives
  Slider, Checkbox, ColorPicker, Select, Section, VectorInput, Panel, Tabs,
  
  // Panels
  EnvironmentPanel, ObjectsPanel, ObjectPanel, MaterialPanel, RenderingPanel, TerrainPanel,
  
  // Layout
  MenuBar,
  
  // Types
  type SliderProps, type MenuDefinition, type NoiseParams,
} from './components';
```

### MenuBar Usage

```tsx
const menus: MenuDefinition[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      { id: 'save', label: 'Save Scene', shortcut: '⌘S', onClick: saveScene },
      { id: 'load', label: 'Load Scene', onClick: loadScene },
    ],
  },
  {
    id: 'scene',
    label: 'Scene',
    items: [
      {
        id: 'add',
        label: 'Add',
        submenu: [
          { id: 'cube', label: 'Cube', onClick: () => addPrimitive('cube') },
          { id: 'terrain', label: 'Terrain', onClick: addTerrain },
        ],
      },
      { separator: true },
      { id: 'group', label: 'Group Selection', shortcut: '⌘G', disabled: selectionCount < 2 },
    ],
  },
];

<MenuBar menus={menus} />
```

### Dependencies

The component system requires:
- `preact` (already in package.json)
- `preact/hooks` (included with preact)
- `@preact/signals` (optional, for full SidebarApp integration)

Install signals if using Option 2:
```bash
npm install @preact/signals
```

### CSS Variables

Import the variables CSS in your app entry or let Vite handle it:

```typescript
import './components/styles/variables.css';
```
