import { mat4, quat, vec3 } from 'gl-matrix';

/**
 * Camera manager - handles view and projection matrix creation
 */
export function createCamera(options = {}) {
  const {
    fov = Math.PI / 3,
    near = 0.1,
    far = 100,
    aspectRatio = 4 / 3,
  } = options;
  
  // Camera state
  let position = vec3.fromValues(0, 0, 3);
  let target = vec3.fromValues(0, 0, 0);
  let up = vec3.fromValues(0, 1, 0);
  
  // Cached matrices
  const viewMatrix = mat4.create();
  const projectionMatrix = mat4.create();
  const viewProjectionMatrix = mat4.create();
  
  let currentAspectRatio = aspectRatio;
  let currentFov = fov;
  let projectionDirty = true;
  let viewDirty = true;
  
  function updateProjection() {
    mat4.perspective(projectionMatrix, currentFov, currentAspectRatio, near, far);
    projectionDirty = false;
  }
  
  function updateView() {
    mat4.lookAt(viewMatrix, position, target, up);
    viewDirty = false;
  }
  
  return {
    /**
     * Set camera position
     * @param {number} x 
     * @param {number} y 
     * @param {number} z 
     */
    setPosition(x, y, z) {
      vec3.set(position, x, y, z);
      viewDirty = true;
    },
    
    /**
     * Set camera target (look-at point)
     * @param {number} x 
     * @param {number} y 
     * @param {number} z 
     */
    setTarget(x, y, z) {
      vec3.set(target, x, y, z);
      viewDirty = true;
    },
    
    /**
     * Set aspect ratio (width / height)
     * @param {number} ratio 
     */
    setAspectRatio(ratio) {
      currentAspectRatio = ratio;
      projectionDirty = true;
    },
    
    /**
     * Set field of view in radians
     * @param {number} fovRadians 
     */
    setFov(fovRadians) {
      currentFov = fovRadians;
      projectionDirty = true;
    },
    
    /**
     * Get the view matrix
     * @returns {mat4}
     */
    getViewMatrix() {
      if (viewDirty) {
        updateView();
      }
      return viewMatrix;
    },
    
    /**
     * Get the projection matrix
     * @returns {mat4}
     */
    getProjectionMatrix() {
      if (projectionDirty) {
        updateProjection();
      }
      return projectionMatrix;
    },
    
    /**
     * Get combined view-projection matrix
     * @returns {mat4}
     */
    getViewProjectionMatrix() {
      if (projectionDirty) {
        updateProjection();
      }
      if (viewDirty) {
        updateView();
      }
      mat4.multiply(viewProjectionMatrix, projectionMatrix, viewMatrix);
      return viewProjectionMatrix;
    },
    
    /**
     * Get current camera position
     * @returns {vec3}
     */
    getPosition() {
      return vec3.clone(position);
    },
  };
}
