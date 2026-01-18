import { quat } from 'gl-matrix';

/**
 * Drag controller - handles mouse drag to rotate the model
 */
export function createDragController(canvas, options = {}) {
  const { sensitivity = 0.01 } = options;
  
  // Model rotation state
  const modelRotation = quat.create();
  
  // Mouse state
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;
  
  function onMouseDown(e) {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    canvas.style.cursor = 'grabbing';
  }
  
  function onMouseMove(e) {
    if (!isDragging) return;
    
    const deltaX = e.clientX - lastMouseX;
    const deltaY = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    
    // Create rotation quaternions for X and Y axes
    const rotY = quat.create();
    const rotX = quat.create();
    quat.setAxisAngle(rotY, [0, 1, 0], deltaX * sensitivity);
    quat.setAxisAngle(rotX, [1, 0, 0], deltaY * sensitivity);
    
    // Apply rotations
    quat.multiply(modelRotation, rotY, modelRotation);
    quat.multiply(modelRotation, rotX, modelRotation);
    quat.normalize(modelRotation, modelRotation);
  }
  
  function onMouseUp() {
    isDragging = false;
    canvas.style.cursor = 'grab';
  }
  
  function onMouseLeave() {
    isDragging = false;
  }
  
  // Attach event listeners
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', onMouseLeave);
  
  // Set initial cursor
  canvas.style.cursor = 'grab';
  
  return {
    /**
     * Get the current model rotation quaternion
     * @returns {quat}
     */
    getRotation() {
      return quat.clone(modelRotation);
    },
    
    /**
     * Set the model rotation
     * @param {quat} rotation 
     */
    setRotation(rotation) {
      quat.copy(modelRotation, rotation);
    },
    
    /**
     * Reset rotation to identity
     */
    reset() {
      quat.identity(modelRotation);
    },
    
    /**
     * Enable the controller (attach listeners)
     */
    enable() {
      canvas.style.cursor = 'grab';
    },
    
    /**
     * Disable the controller
     */
    disable() {
      isDragging = false;
      canvas.style.cursor = 'default';
    },
    
    /**
     * Clean up event listeners
     */
    destroy() {
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.style.cursor = 'default';
    },
    
    /**
     * Update method (no-op for drag controller, rotation is event-driven)
     */
    update() {
      // Rotation is updated via mouse events, nothing to do here
    },
  };
}
