import { mat4, quat } from 'gl-matrix';
import { loadOBJ, loadGLB } from '../../loaders';
import { createAnimationLoop } from '../../core/animationLoop';
import { createCamera } from '../../core/camera';
import { createOrbitController } from '../../controls/orbitController';
import { createDragController } from '../../controls/dragController';
import { createRotationGizmo } from '../../controls/rotationGizmo';
import { createCanvasRenderer } from '../../renderers/canvasRenderer';
import { createWebGLRenderer } from '../../renderers/webglRenderer';
import { createTexturedRenderer } from '../../renderers/texturedRenderer';

// Available models
const MODELS = [
  { name: 'Cube', file: 'cube.obj', type: 'obj' },
  { name: 'Pyramid', file: 'pyramid.obj', type: 'obj' },
  { name: 'Tea pot', file: 'tea-pot.obj', type: 'obj' },
  { name: 'Duck', file: 'duck.glb', type: 'glb' },
];

// Renderer factories
const WIREFRAME_RENDERERS = {
  canvas: createCanvasRenderer,
  webgl: createWebGLRenderer,
};

/**
 * Model Viewer Demo
 * Interactive 3D model viewer with orbit/drag controls
 */
export function createModelViewerDemo(container, options = {}) {
  const { width: CANVAS_WIDTH = 800, height: CANVAS_HEIGHT = 600, onFps = () => {} } = options;
  
  // Create DOM structure
  container.innerHTML = `
    <div id="model-viewer-controls" class="demo-controls">
      <select id="renderer-select">
        <option value="canvas">Canvas 2D</option>
        <option value="webgl">WebGL</option>
      </select>
      <select id="model-select"></select>
      <select id="control-mode">
        <option value="orbit">Camera Orbit</option>
        <option value="drag">Mouse Drag</option>
      </select>
      <label id="gizmo-toggle" style="display: none;">
        <input type="checkbox" id="show-gizmo">
        <span>Rotation Guides</span>
      </label>
      <button id="rx">RX</button>
      <button id="ry">RY</button>
      <button id="rz">RZ</button>
      <button id="reset">Reset</button>
    </div>
    <div id="canvas-container">
      <canvas id="canvas"></canvas>
      <canvas id="gizmo-canvas"></canvas>
    </div>
    <div id="demo-footer" class="demo-footer">
      <div id="stats"></div>
      <div id="speed-control">
        <label for="speed">Speed: <span id="speed-value">1x</span></label>
        <input type="range" id="speed" min="0" max="5" step="0.1" value="1">
      </div>
    </div>
  `;
  
  // Canvas setup
  let canvas = container.querySelector('#canvas');
  let gizmoCanvas = container.querySelector('#gizmo-canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  gizmoCanvas.width = CANVAS_WIDTH;
  gizmoCanvas.height = CANVAS_HEIGHT;
  
  function recreateCanvas() {
    const canvasContainer = container.querySelector('#canvas-container');
    const oldCanvas = canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'canvas';
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    canvasContainer.replaceChild(canvas, oldCanvas);
    return canvas;
  }
  
  // Current state
  let currentModel = null;
  let currentModelType = 'obj';
  let currentRendererType = 'canvas';
  let currentControlMode = 'orbit';
  
  // Active components
  let animationLoop = null;
  let camera = null;
  let controller = null;
  let renderer = null;
  let dragController = null;
  let rotationGizmo = null;
  let showGizmo = false;
  
  // Model matrix for rotation
  const modelMatrix = mat4.create();
  
  
  function updateStats(model, type) {
    if (type === 'obj') {
      container.querySelector('#stats').textContent = 
        `${model.vertices.length} vertices · ${model.edges.length} edges`;
    } else {
      const vertexCount = model.meshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
      const triangleCount = model.meshes.reduce((sum, m) => sum + (m.indices?.length || m.positions.length / 3) / 3, 0);
      container.querySelector('#stats').textContent = 
        `${vertexCount} vertices · ${Math.round(triangleCount)} triangles`;
    }
  }
  
  async function loadModel(modelInfo) {
    if (modelInfo.type === 'glb') {
      return await loadGLB(`/models/${modelInfo.file}`);
    } else {
      return await loadOBJ(`/models/${modelInfo.file}`);
    }
  }
  
  function createRenderer(model, modelType, rendererType) {
    if (modelType === 'glb') {
      return createTexturedRenderer(canvas, model);
    } else {
      const createFn = WIREFRAME_RENDERERS[rendererType];
      return createFn(canvas, model, { foreground: '#f0f0f0' });
    }
  }
  
  function setupOrbitMode() {
    if (dragController) {
      dragController.destroy();
      dragController = null;
    }
    
    camera = createCamera({
      aspectRatio: CANVAS_WIDTH / CANVAS_HEIGHT,
    });
    camera.setTarget(0, 0, 0);
    
    controller = createOrbitController(camera, {
      radius: 2,
      height: 0.8,
      period: 5000,
    });
    
    const speedSlider = container.querySelector('#speed');
    controller.setSpeed(parseFloat(speedSlider.value));
    
    mat4.identity(modelMatrix);
    canvas.style.cursor = 'default';
  }
  
  function setupDragMode() {
    controller = null;
    
    camera = createCamera({
      aspectRatio: CANVAS_WIDTH / CANVAS_HEIGHT,
    });
    camera.setPosition(0, 0, 2);
    camera.setTarget(0, 0, 0);
    
    dragController = createDragController(canvas);
    
    if (rotationGizmo) {
      rotationGizmo.destroy();
    }
    rotationGizmo = createRotationGizmo(gizmoCanvas, { radius: 0.7 });
    rotationGizmo.setEnabled(showGizmo);
    
    gizmoCanvas.classList.toggle('active', showGizmo);
    
    mat4.identity(modelMatrix);
  }
  
  function startRendering() {
    if (!renderer || !camera) return;
    
    if (animationLoop) {
      animationLoop.stop();
    }
    
    animationLoop = createAnimationLoop({ onFps });
    
    animationLoop.start((deltaTime) => {
      if (currentControlMode === 'orbit' && controller) {
        controller.update(deltaTime);
      } else if (currentControlMode === 'drag') {
        if (rotationGizmo && showGizmo) {
          const rotation = rotationGizmo.getRotation();
          mat4.fromQuat(modelMatrix, rotation);
          if (dragController && !rotationGizmo.isDragging()) {
            dragController.setRotation(rotation);
          }
        } else if (dragController) {
          const rotation = dragController.getRotation();
          mat4.fromQuat(modelMatrix, rotation);
          if (rotationGizmo) {
            rotationGizmo.setRotation(rotation);
          }
        }
      }
      
      const vpMatrix = camera.getViewProjectionMatrix();
      
      renderer.render(vpMatrix, modelMatrix);
      
      if (currentControlMode === 'drag' && rotationGizmo && showGizmo) {
        const gizmoCtx = gizmoCanvas.getContext('2d');
        gizmoCtx.clearRect(0, 0, gizmoCanvas.width, gizmoCanvas.height);
        rotationGizmo.render(vpMatrix);
      }
    });
  }
  
  async function startApp(modelInfo, rendererType = currentRendererType) {
    if (animationLoop) {
      animationLoop.stop();
    }
    
    if (renderer) {
      renderer.destroy();
      renderer = null;
    }
    
    const newModelType = modelInfo.type;
    const needsNewContext = (newModelType !== currentModelType) || 
                            (newModelType === 'obj' && rendererType !== currentRendererType);
    
    if (needsNewContext) {
      if (dragController) {
        dragController.destroy();
        dragController = null;
      }
      recreateCanvas();
    }
    
    currentModelType = newModelType;
    currentRendererType = rendererType;
    
    currentModel = await loadModel(modelInfo);
    updateStats(currentModel, modelInfo.type);
    
    renderer = createRenderer(currentModel, modelInfo.type, rendererType);
    
    container.querySelector('#renderer-select').disabled = (modelInfo.type === 'glb');
    
    if (currentControlMode === 'orbit') {
      setupOrbitMode();
    } else {
      setupDragMode();
    }
    
    startRendering();
  }
  
  function updateControlModeUI(mode) {
    const speedControl = container.querySelector('#speed-control');
    const rotationButtons = container.querySelectorAll('#rx, #ry, #rz, #reset');
    const gizmoToggle = container.querySelector('#gizmo-toggle');
    
    if (mode === 'drag') {
      speedControl.style.display = 'none';
      rotationButtons.forEach(btn => btn.style.display = 'none');
      gizmoToggle.style.display = 'flex';
    } else {
      speedControl.style.display = '';
      rotationButtons.forEach(btn => btn.style.display = '');
      gizmoToggle.style.display = 'none';
      gizmoCanvas.classList.remove('active');
      if (rotationGizmo) {
        rotationGizmo.destroy();
        rotationGizmo = null;
      }
      const gizmoCtx = gizmoCanvas.getContext('2d');
      gizmoCtx.clearRect(0, 0, gizmoCanvas.width, gizmoCanvas.height);
    }
  }
  
  // Initialize
  async function init() {
    // Populate model dropdown
    const modelSelect = container.querySelector('#model-select');
    modelSelect.innerHTML = MODELS.map((m, i) => 
      `<option value="${i}">${m.name}${m.type === 'glb' ? ' (textured)' : ''}</option>`
    ).join('');
    
    // Model selection handler
    modelSelect.addEventListener('change', (e) => {
      const modelInfo = MODELS[parseInt(e.target.value)];
      startApp(modelInfo);
    });
    
    // Renderer selection handler
    const rendererSelect = container.querySelector('#renderer-select');
    rendererSelect.addEventListener('change', (e) => {
      if (currentModelType === 'obj') {
        const modelIndex = parseInt(modelSelect.value);
        startApp(MODELS[modelIndex], e.target.value);
      }
    });
    
    // Control mode handler
    const controlModeSelect = container.querySelector('#control-mode');
    controlModeSelect.addEventListener('change', (e) => {
      currentControlMode = e.target.value;
      updateControlModeUI(currentControlMode);
      
      if (currentControlMode === 'orbit') {
        setupOrbitMode();
        const speedSlider = container.querySelector('#speed');
        speedSlider.value = 1;
        container.querySelector('#speed-value').textContent = '1x';
      } else {
        setupDragMode();
      }
      
      startRendering();
    });
    
    // Speed slider handler
    const speedSlider = container.querySelector('#speed');
    const speedValue = container.querySelector('#speed-value');
    
    speedSlider.addEventListener('input', (e) => {
      const speed = parseFloat(e.target.value);
      speedValue.textContent = speed === 0 ? '0x' : `${speed.toFixed(1)}x`;
      if (controller) {
        controller.setSpeed(speed);
      }
    });
    
    // Rotation button handlers
    const ROTATION_STEP = Math.PI / 12;
    
    container.querySelector('#rx').addEventListener('click', () => {
      const rotQuat = quat.create();
      quat.setAxisAngle(rotQuat, [1, 0, 0], ROTATION_STEP);
      const currentQuat = quat.create();
      mat4.getRotation(currentQuat, modelMatrix);
      quat.multiply(currentQuat, rotQuat, currentQuat);
      mat4.fromQuat(modelMatrix, currentQuat);
    });
    
    container.querySelector('#ry').addEventListener('click', () => {
      const rotQuat = quat.create();
      quat.setAxisAngle(rotQuat, [0, 1, 0], ROTATION_STEP);
      const currentQuat = quat.create();
      mat4.getRotation(currentQuat, modelMatrix);
      quat.multiply(currentQuat, rotQuat, currentQuat);
      mat4.fromQuat(modelMatrix, currentQuat);
    });
    
    container.querySelector('#rz').addEventListener('click', () => {
      const rotQuat = quat.create();
      quat.setAxisAngle(rotQuat, [0, 0, 1], ROTATION_STEP);
      const currentQuat = quat.create();
      mat4.getRotation(currentQuat, modelMatrix);
      quat.multiply(currentQuat, rotQuat, currentQuat);
      mat4.fromQuat(modelMatrix, currentQuat);
    });
    
    container.querySelector('#reset').addEventListener('click', () => {
      mat4.identity(modelMatrix);
      if (dragController) {
        dragController.reset();
      }
      if (rotationGizmo) {
        rotationGizmo.reset();
      }
    });
    
    // Gizmo toggle handler
    const gizmoCheckbox = container.querySelector('#show-gizmo');
    gizmoCheckbox.addEventListener('change', (e) => {
      showGizmo = e.target.checked;
      if (rotationGizmo) {
        rotationGizmo.setEnabled(showGizmo);
      }
      gizmoCanvas.classList.toggle('active', showGizmo);
      if (!showGizmo) {
        const gizmoCtx = gizmoCanvas.getContext('2d');
        gizmoCtx.clearRect(0, 0, gizmoCanvas.width, gizmoCanvas.height);
      }
      if (!showGizmo && dragController) {
        dragController.enable();
      }
    });
    
    // Load initial model
    await startApp(MODELS[0]);
  }
  
  // Cleanup
  function destroy() {
    if (animationLoop) {
      animationLoop.stop();
      animationLoop = null;
    }
    if (renderer) {
      renderer.destroy();
      renderer = null;
    }
    if (dragController) {
      dragController.destroy();
      dragController = null;
    }
    if (rotationGizmo) {
      rotationGizmo.destroy();
      rotationGizmo = null;
    }
    container.innerHTML = '';
  }
  
  return {
    init,
    destroy,
    name: 'Model Viewer',
    description: 'Interactive 3D model viewer with orbit and drag controls',
  };
}
