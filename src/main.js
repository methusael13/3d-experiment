import './style.css';
import { createPreactSceneBuilderDemo } from './demos/sceneBuilder/PreactSceneBuilderDemo';

// App state
let app = null;

async function init() {
  const container = document.getElementById('app');
  
  // Create and initialize the Preact Scene Builder
  app = createPreactSceneBuilderDemo(container, {
    // Full viewport size - resize handled internally
    onFps: () => {}, // FPS will be handled by MenuBar internally
  });
  
  await app.init();
}

init();
