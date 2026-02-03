import './style.css';
import { createModelViewerDemo } from './demos/modelViewer/index';
import { createSceneBuilderDemo } from './demos/sceneBuilder/SceneBuilder';
import { createPreactSceneBuilderDemo } from './demos/sceneBuilder/PreactSceneBuilderDemo';

// Canvas dimensions
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 800;

// Available demos
const DEMOS = [
  {
    id: 'model-viewer',
    name: 'Model Viewer',
    description: 'Interactive 3D model viewer with orbit and drag controls',
    create: createModelViewerDemo,
  },
  {
    id: 'scene-builder',
    name: 'Scene Builder',
    description: 'Import and position 3D models to create composite scenes',
    create: createSceneBuilderDemo,
  },
  {
    id: 'scene-builder-preact',
    name: 'Scene Builder (Preact)',
    description: 'Import and position 3D models - Preact UI (experimental)',
    create: createPreactSceneBuilderDemo,
  },
];

// App state
let currentDemo = null;

function init() {
  const demoSelector = document.getElementById('demo-selector');
  const demoContainer = document.getElementById('demo-container');
  const demoDescription = document.getElementById('demo-description');
  
  // Populate demo selector
  demoSelector.innerHTML = DEMOS.map(demo => 
    `<option value="${demo.id}">${demo.name}</option>`
  ).join('');
  
  // Handle demo selection
  demoSelector.addEventListener('change', (e) => {
    loadDemo(e.target.value);
  });
  
  const fpsDisplay = document.getElementById('fps-display');
  
  function updateFps(fps) {
    fpsDisplay.textContent = `${fps} FPS`;
  }
  
  // Load demo
  async function loadDemo(demoId) {
    const demoConfig = DEMOS.find(d => d.id === demoId);
    if (!demoConfig) return;
    
    // Clean up current demo
    if (currentDemo) {
      currentDemo.destroy();
      currentDemo = null;
    }
    
    // Update description
    demoDescription.textContent = demoConfig.description;
    
    // Create and initialize new demo
    currentDemo = demoConfig.create(demoContainer, {
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      onFps: updateFps,
    });
    await currentDemo.init();
  }
  
  // Load initial demo
  loadDemo(DEMOS[0].id);
}

init();
