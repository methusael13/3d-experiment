import { createCamera } from '../../core/camera';
import { screenToRay, raycastToGround } from './raycastUtils';

/**
 * Camera Controller - manages camera state, orbit controls, and input handling
 * 
 * @param {Object} options - Configuration options
 * @param {HTMLCanvasElement} options.canvas - Canvas element for input events
 * @param {number} options.width - Canvas width
 * @param {number} options.height - Canvas height
 */
export function createCameraController(options) {
  const { canvas, width, height } = options;
  
  // Camera instance
  const camera = createCamera({
    aspectRatio: width / height,
    fov: 45,
    near: 0.1,
    far: 100,
  });
  
  // Orbit state
  let angleX = 0.5;
  let angleY = 0.3;
  let distance = 5;
  
  // Pan offsets
  let offsetX = 0;
  let offsetY = 0;
  let offsetZ = 0;
  
  // Origin marker position
  let originPos = [0, 0, 0];
  
  // Grid bounds for raycast
  const GRID_BOUNDS = 10;
  
  // View mode tracking
  let savedHomeState = null;
  let currentViewMode = 'free';
  
  // Input state
  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;
  let mouseDownX = 0;
  let mouseDownY = 0;
  let hasMoved = false;
  
  // Callbacks
  let onViewModeChange = null;
  let onClick = null;
  
  // ==================== Position Calculation ====================
  
  function updatePosition() {
    const targetX = originPos[0] + offsetX;
    const targetY = originPos[1] + offsetY;
    const targetZ = originPos[2] + offsetZ;
    
    const x = Math.sin(angleX) * Math.cos(angleY) * distance;
    const y = Math.sin(angleY) * distance;
    const z = Math.cos(angleX) * Math.cos(angleY) * distance;
    
    camera.setPosition(x + targetX, y + targetY, z + targetZ);
    camera.setTarget(targetX, targetY, targetZ);
  }
  
  // ==================== Orbit Controls ====================
  
  function orbit(dx, dy) {
    if (currentViewMode !== 'free') {
      saveHomeState();
      currentViewMode = 'free';
      if (onViewModeChange) onViewModeChange(currentViewMode);
    }
    
    angleX -= dx * 0.01;
    angleY += dy * 0.01;
    angleY = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, angleY));
    updatePosition();
    saveHomeState();
  }
  
  function pan(dx, dy) {
    if (currentViewMode !== 'free') {
      saveHomeState();
      currentViewMode = 'free';
      if (onViewModeChange) onViewModeChange(currentViewMode);
    }
    
    const rightX = Math.cos(angleX);
    const rightZ = -Math.sin(angleX);
    const upX = -Math.sin(angleX) * Math.sin(angleY);
    const upY = Math.cos(angleY);
    const upZ = -Math.cos(angleX) * Math.sin(angleY);
    
    const panSpeed = 0.01 * distance * 0.5;
    offsetX -= (dx * rightX - dy * upX) * panSpeed;
    offsetY += dy * upY * panSpeed;
    offsetZ -= (dx * rightZ - dy * upZ) * panSpeed;
    
    updatePosition();
    saveHomeState();
  }
  
  function zoom(delta) {
    if (currentViewMode !== 'free') {
      saveHomeState();
      currentViewMode = 'free';
      if (onViewModeChange) onViewModeChange(currentViewMode);
    }
    
    distance += delta * 0.01;
    distance = Math.max(1, Math.min(20, distance));
    updatePosition();
    saveHomeState();
  }
  
  // ==================== Origin Control ====================
  
  function setOriginFromScreenPos(screenX, screenY) {
    const hit = raycastToGround(screenX, screenY, camera, width, height, GRID_BOUNDS);
    if (hit) {
      const camPos = camera.getPosition();
      const newOrigin = [hit[0], 0, hit[1]];
      
      const dx = camPos[0] - newOrigin[0];
      const dy = camPos[1] - newOrigin[1];
      const dz = camPos[2] - newOrigin[2];
      
      const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const horizontalDist = Math.sqrt(dx * dx + dz * dz);
      const newAngleY = Math.atan2(dy, horizontalDist);
      const newAngleX = Math.atan2(dx, dz);
      
      originPos = newOrigin;
      angleX = newAngleX;
      angleY = newAngleY;
      distance = newDistance;
      offsetX = 0;
      offsetY = 0;
      offsetZ = 0;
      
      updatePosition();
    }
  }
  
  function resetOrigin() {
    const camPos = camera.getPosition();
    const newOrigin = [0, 0, 0];
    
    const dx = camPos[0] - newOrigin[0];
    const dy = camPos[1] - newOrigin[1];
    const dz = camPos[2] - newOrigin[2];
    
    const newDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const newAngleY = Math.atan2(dy, horizontalDist);
    const newAngleX = Math.atan2(dx, dz);
    
    originPos = newOrigin;
    angleX = newAngleX;
    angleY = newAngleY;
    distance = newDistance;
    offsetX = 0;
    offsetY = 0;
    offsetZ = 0;
    
    updatePosition();
  }
  
  function getOriginPosition() {
    return [...originPos];
  }
  
  // ==================== View Presets ====================
  
  function saveHomeState() {
    savedHomeState = {
      angleX,
      angleY,
      distance,
      offsetX,
      offsetY,
      offsetZ,
    };
  }
  
  function setView(view) {
    if (view === 'home') {
      if (savedHomeState) {
        angleX = savedHomeState.angleX;
        angleY = savedHomeState.angleY;
        distance = savedHomeState.distance;
        offsetX = savedHomeState.offsetX;
        offsetY = savedHomeState.offsetY;
        offsetZ = savedHomeState.offsetZ;
        currentViewMode = 'free';
        updatePosition();
      }
      return;
    }
    
    if (currentViewMode === 'free') saveHomeState();
    
    offsetX = 0;
    offsetY = 0;
    offsetZ = 0;
    
    switch (view) {
      case 'front': angleX = 0; angleY = 0; break;
      case 'side': angleX = Math.PI / 2; angleY = 0; break;
      case 'top': angleX = 0; angleY = Math.PI / 2 - 0.001; break;
    }
    
    currentViewMode = view;
    updatePosition();
    if (onViewModeChange) onViewModeChange(currentViewMode);
  }
  
  // ==================== Serialization ====================
  
  function serialize() {
    return {
      angleX,
      angleY,
      distance,
      originX: originPos[0],
      originY: originPos[1],
      originZ: originPos[2],
      offsetX,
      offsetY,
      offsetZ,
    };
  }
  
  function deserialize(state) {
    if (!state) return;
    
    angleX = state.angleX ?? 0.5;
    angleY = state.angleY ?? 0.3;
    distance = state.distance ?? 5;
    originPos = [state.originX ?? 0, state.originY ?? 0, state.originZ ?? 0];
    offsetX = state.offsetX ?? 0;
    offsetY = state.offsetY ?? 0;
    offsetZ = state.offsetZ ?? 0;
    updatePosition();
  }
  
  // ==================== Input Handling ====================
  
  function handleMouseDown(e, isGizmoInteracting = false) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Check if gizmo should handle this
    if (e.button === 0 && isGizmoInteracting) {
      return { handled: true, x, y };
    }
    
    if (e.button === 0) isDragging = true;
    else if (e.button === 2) isPanning = true;
    
    lastX = e.clientX;
    lastY = e.clientY;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    hasMoved = false;
    
    return { handled: false, x, y };
  }
  
  function handleMouseMove(e, isGizmoInteracting = false) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    if (isGizmoInteracting) {
      return { x, y, hasMoved };
    }
    
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    
    if (Math.abs(e.clientX - mouseDownX) > 3 || Math.abs(e.clientY - mouseDownY) > 3) {
      hasMoved = true;
    }
    
    if (isDragging && hasMoved) {
      orbit(dx, dy);
    } else if (isPanning) {
      pan(dx, dy);
    }
    
    return { x, y, hasMoved };
  }
  
  function handleMouseUp(e, isGizmoInteracting = false) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    if (isGizmoInteracting) {
      return { clicked: false, x, y, shiftKey: e.shiftKey };
    }
    
    const clicked = e.button === 0 && !hasMoved;
    
    isDragging = false;
    isPanning = false;
    
    if (clicked && onClick) {
      onClick(x, y, e.shiftKey);
    }
    
    return { clicked, x, y, shiftKey: e.shiftKey };
  }
  
  function handleMouseLeave() {
    isDragging = false;
    isPanning = false;
  }
  
  function handleWheel(e) {
    e.preventDefault();
    zoom(e.deltaY);
  }
  
  function handleDoubleClick(e) {
    const rect = canvas.getBoundingClientRect();
    setOriginFromScreenPos(e.clientX - rect.left, e.clientY - rect.top);
  }
  
  function setupEventListeners(callbacks = {}) {
    const { onGizmoCheck = () => false, onGizmoMouseDown, onGizmoMouseMove, onGizmoMouseUp } = callbacks;
    onClick = callbacks.onClick || null;
    onViewModeChange = callbacks.onViewModeChange || null;
    
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      // Let external handler check if gizmo should intercept
      if (e.button === 0 && onGizmoMouseDown && onGizmoMouseDown(x, y)) {
        return;
      }
      
      handleMouseDown(e, false);
    });
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (onGizmoCheck()) {
        if (onGizmoMouseMove) onGizmoMouseMove(x, y);
        return;
      }
      
      handleMouseMove(e, false);
    });
    
    canvas.addEventListener('mouseup', (e) => {
      if (onGizmoCheck()) {
        if (onGizmoMouseUp) onGizmoMouseUp();
        return;
      }
      
      handleMouseUp(e, false);
    });
    
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('wheel', handleWheel);
    canvas.addEventListener('dblclick', handleDoubleClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  
  // Initialize position
  updatePosition();
  
  // ==================== Public Interface ====================
  
  return {
    // Camera access
    getCamera: () => camera,
    getViewProjectionMatrix: () => camera.getViewProjectionMatrix(),
    
    // State
    getOriginPosition,
    getCurrentViewMode: () => currentViewMode,
    
    // Controls
    orbit,
    pan,
    zoom,
    setView,
    resetOrigin,
    setOriginFromScreenPos,
    
    // Serialization
    serialize,
    deserialize,
    
    // Event setup
    setupEventListeners,
    
    // Manual input handling (if not using setupEventListeners)
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    handleWheel,
    handleDoubleClick,
    
    // Callbacks
    set onClick(fn) { onClick = fn; },
    set onViewModeChange(fn) { onViewModeChange = fn; },
  };
}
