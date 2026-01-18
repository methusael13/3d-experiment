import { mat4, vec3, quat, vec4 } from 'gl-matrix';

/**
 * Rotation gizmo - draws RGB circles for X/Y/Z axis rotation
 * and handles mouse interaction for axis-constrained rotation
 */
export function createRotationGizmo(canvas, options = {}) {
  const {
    radius = 0.8,
    lineWidth = 3,
    hitWidth = 15, // Pixel width for hit detection
    segments = 64,
  } = options;
  
  const ctx = canvas.getContext('2d');
  
  // Colors for each axis
  const AXIS_COLORS = {
    x: '#ff4444', // Red
    y: '#44ff44', // Green
    z: '#4488ff', // Blue
  };
  
  const AXIS_COLORS_HIGHLIGHT = {
    x: '#ff8888',
    y: '#88ff88',
    z: '#88bbff',
  };
  
  // State
  let modelRotation = quat.create();
  let viewProjectionMatrix = mat4.create();
  let hoveredAxis = null;
  let dragAxis = null;
  let lastMousePos = { x: 0, y: 0 };
  let enabled = true;
  
  // Generate circle points for an axis
  function generateCirclePoints(axis) {
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      let x, y, z;
      
      if (axis === 'x') {
        x = 0;
        y = Math.cos(angle) * radius;
        z = Math.sin(angle) * radius;
      } else if (axis === 'y') {
        x = Math.cos(angle) * radius;
        y = 0;
        z = Math.sin(angle) * radius;
      } else {
        x = Math.cos(angle) * radius;
        y = Math.sin(angle) * radius;
        z = 0;
      }
      
      points.push({ x, y, z });
    }
    return points;
  }
  
  // Transform 3D point to screen space
  function toScreen(point, mvpMatrix) {
    const vec = vec4.fromValues(point.x, point.y, point.z, 1);
    vec4.transformMat4(vec, vec, mvpMatrix);
    
    if (vec[3] <= 0) return null;
    
    const x = vec[0] / vec[3];
    const y = vec[1] / vec[3];
    
    return {
      x: (x + 1) * canvas.width / 2,
      y: (1 - y) * canvas.height / 2,
    };
  }
  
  // Check if mouse is near a circle (only front-facing parts)
  function getHoveredAxis(mouseX, mouseY, mvpMatrix) {
    const axes = ['x', 'y', 'z'];
    
    for (const axis of axes) {
      const points = generateCirclePoints(axis);
      
      // Transform points and track Z for front-face culling
      const transformedPoints = points.map(p => {
        const rotated = vec3.create();
        vec3.transformQuat(rotated, [p.x, p.y, p.z], modelRotation);
        const screen = toScreen({ x: rotated[0], y: rotated[1], z: rotated[2] }, mvpMatrix);
        return {
          screen,
          z: rotated[2], // Z in world space (positive = toward camera)
        };
      });
      
      // Check distance to front-facing line segments only
      for (let i = 0; i < transformedPoints.length - 1; i++) {
        const p1 = transformedPoints[i];
        const p2 = transformedPoints[i + 1];
        
        // Skip if both points are back-facing
        if (p1.z < 0 && p2.z < 0) continue;
        if (!p1.screen || !p2.screen) continue;
        
        const dist = pointToSegmentDistance(mouseX, mouseY, p1.screen.x, p1.screen.y, p2.screen.x, p2.screen.y);
        
        if (dist < hitWidth) {
          return axis;
        }
      }
    }
    
    return null;
  }
  
  // Point to line segment distance
  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    
    if (lenSq === 0) {
      return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
    }
    
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    
    const nearestX = x1 + t * dx;
    const nearestY = y1 + t * dy;
    
    return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
  }
  
  // Sensitivity: radians per pixel of mouse movement
  const rotationSensitivity = 0.01;
  
  // Store previous mouse position for incremental rotation
  let prevMouseX = 0;
  let prevMouseY = 0;
  
  // Store the locked tangent direction for the current drag
  // This prevents direction flipping when circles are edge-on
  let lockedTangentX = 0;
  let lockedTangentY = 0;
  let lockedAxisFlip = 1;
  
  // Calculate and lock tangent direction at drag start
  function lockTangentDirection(mouseX, mouseY, axis) {
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    
    // Get the local axis vector and transform to world space
    const axisVec = axis === 'x' ? [1, 0, 0] : 
                    axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    
    const worldAxis = vec3.create();
    vec3.transformQuat(worldAxis, axisVec, modelRotation);
    
    // Use position relative to center to get local tangent direction
    const toMouseX = mouseX - centerX;
    const toMouseY = mouseY - centerY;
    
    // Tangent is perpendicular to radius (counter-clockwise)
    let tangentX = -toMouseY;
    let tangentY = toMouseX;
    
    // Normalize
    const tangentLen = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
    if (tangentLen < 10) {
      // Mouse is near center, use a default direction based on axis orientation
      // Project the rotation axis perpendicular to screen space
      // For rotation around axis A, screen movement perpendicular to A causes rotation
      const screenAxisX = worldAxis[0];
      const screenAxisY = -worldAxis[1];
      
      // Perpendicular to screen axis
      tangentX = -screenAxisY;
      tangentY = screenAxisX;
      
      const len = Math.sqrt(tangentX * tangentX + tangentY * tangentY);
      if (len > 0.001) {
        tangentX /= len;
        tangentY /= len;
      } else {
        // Fallback: use horizontal
        tangentX = 1;
        tangentY = 0;
      }
    } else {
      tangentX /= tangentLen;
      tangentY /= tangentLen;
    }
    
    lockedTangentX = tangentX;
    lockedTangentY = tangentY;
    
    // Lock the axis flip direction too
    lockedAxisFlip = worldAxis[2] > 0 ? -1 : 1;
  }
  
  // Calculate incremental rotation based on mouse movement using locked tangent
  function getIncrementalRotation(mouseX, mouseY, prevX, prevY) {
    // Mouse movement delta
    const deltaX = mouseX - prevX;
    const deltaY = mouseY - prevY;
    
    // Project mouse movement onto locked tangent direction
    const tangentMovement = deltaX * lockedTangentX + deltaY * lockedTangentY;
    
    // Convert to rotation angle with locked flip direction
    const deltaAngle = tangentMovement * rotationSensitivity * lockedAxisFlip;
    
    return deltaAngle;
  }
  
  // Mouse event handlers
  function onMouseMove(e) {
    if (!enabled) return;
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    if (dragAxis) {
      // Calculate incremental rotation based on mouse movement delta using locked tangent
      const deltaAngle = getIncrementalRotation(mouseX, mouseY, prevMouseX, prevMouseY);
      
      // Create rotation quaternion for this axis (in local space)
      const axisVec = dragAxis === 'x' ? [1, 0, 0] : 
                      dragAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
      
      // Create incremental rotation around local axis
      const deltaRotation = quat.create();
      quat.setAxisAngle(deltaRotation, axisVec, deltaAngle);
      
      // Apply incremental rotation: newRotation = currentRotation * deltaRotation (local space)
      quat.multiply(modelRotation, modelRotation, deltaRotation);
      quat.normalize(modelRotation, modelRotation);
      
      // Update previous position for next delta
      prevMouseX = mouseX;
      prevMouseY = mouseY;
      
      canvas.style.cursor = 'grabbing';
    } else {
      // Check hover
      hoveredAxis = getHoveredAxis(mouseX, mouseY, viewProjectionMatrix);
      canvas.style.cursor = hoveredAxis ? 'grab' : 'default';
    }
    
    lastMousePos = { x: mouseX, y: mouseY };
  }
  
  // Document-level handler for tracking mouse outside canvas during drag
  function onDocumentMouseMove(e) {
    if (!enabled || !dragAxis) return;
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // Calculate incremental rotation based on mouse movement delta using locked tangent
    const deltaAngle = getIncrementalRotation(mouseX, mouseY, prevMouseX, prevMouseY);
    
    // Create rotation quaternion for this axis (in local space)
    const axisVec = dragAxis === 'x' ? [1, 0, 0] : 
                    dragAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
    
    // Create incremental rotation around local axis
    const deltaRotation = quat.create();
    quat.setAxisAngle(deltaRotation, axisVec, deltaAngle);
    
    // Apply incremental rotation: newRotation = currentRotation * deltaRotation (local space)
    quat.multiply(modelRotation, modelRotation, deltaRotation);
    quat.normalize(modelRotation, modelRotation);
    
    // Update previous position for next delta
    prevMouseX = mouseX;
    prevMouseY = mouseY;
    
    lastMousePos = { x: mouseX, y: mouseY };
  }
  
  function onMouseDown(e) {
    if (!enabled) return;
    
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    const axis = getHoveredAxis(mouseX, mouseY, viewProjectionMatrix);
    if (axis) {
      dragAxis = axis;
      prevMouseX = mouseX;
      prevMouseY = mouseY;
      
      // Lock the tangent direction at drag start to prevent flipping
      lockTangentDirection(mouseX, mouseY, axis);
      
      canvas.style.cursor = 'grabbing';
      e.stopPropagation();
      e.preventDefault();
      
      // Add document-level listeners to track mouse outside canvas
      document.addEventListener('mousemove', onDocumentMouseMove);
      document.addEventListener('mouseup', onDocumentMouseUp);
    }
  }
  
  function onMouseUp() {
    endDrag();
  }
  
  function onDocumentMouseUp() {
    endDrag();
  }
  
  function endDrag() {
    if (dragAxis) {
      dragAxis = null;
      hoveredAxis = getHoveredAxis(lastMousePos.x, lastMousePos.y, viewProjectionMatrix);
      canvas.style.cursor = hoveredAxis ? 'grab' : 'default';
      
      // Remove document-level listeners
      document.removeEventListener('mousemove', onDocumentMouseMove);
      document.removeEventListener('mouseup', onDocumentMouseUp);
    }
  }
  
  // Attach canvas listeners
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', () => {
    hoveredAxis = null;
    if (!dragAxis) {
      canvas.style.cursor = 'default';
    }
  });
  
  return {
    /**
     * Render the gizmo
     * @param {mat4} vpMatrix - View-projection matrix
     * @param {mat4} modelMat - Model matrix (used for display position)
     */
    render(vpMatrix) {
      if (!enabled) return;
      
      mat4.copy(viewProjectionMatrix, vpMatrix);
      
      // Create MVP for the gizmo (gizmo rotates with model)
      const modelMat = mat4.create();
      mat4.fromQuat(modelMat, modelRotation);
      
      const mvpMatrix = mat4.create();
      mat4.multiply(mvpMatrix, vpMatrix, modelMat);
      
      // Draw each axis circle
      const axes = ['x', 'y', 'z'];
      
      for (const axis of axes) {
        const points = generateCirclePoints(axis);
        
        // Transform points and track Z for front-face culling
        const transformedPoints = points.map(p => {
          const screen = toScreen(p, mvpMatrix);
          // Get Z in model space (after model rotation is applied via mvpMatrix)
          // We need to check Z before the view transform to determine facing
          // Since model is at origin and camera is at Z=2, positive Z points are front-facing
          const rotated = vec3.create();
          vec3.transformQuat(rotated, [p.x, p.y, p.z], modelRotation);
          return {
            screen,
            z: rotated[2], // Z in world space (positive = toward camera at Z=2)
          };
        });
        
        const isHighlighted = hoveredAxis === axis || dragAxis === axis;
        const color = isHighlighted ? AXIS_COLORS_HIGHLIGHT[axis] : AXIS_COLORS[axis];
        const backColor = isHighlighted ? 
          (axis === 'x' ? 'rgba(255,68,68,0.2)' : axis === 'y' ? 'rgba(68,255,68,0.2)' : 'rgba(68,136,255,0.2)') :
          (axis === 'x' ? 'rgba(255,68,68,0.1)' : axis === 'y' ? 'rgba(68,255,68,0.1)' : 'rgba(68,136,255,0.1)');
        
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // Draw back-facing parts first (faded)
        ctx.strokeStyle = backColor;
        ctx.lineWidth = isHighlighted ? lineWidth : lineWidth - 1;
        ctx.beginPath();
        let inBackPath = false;
        
        for (let i = 0; i < transformedPoints.length; i++) {
          const p = transformedPoints[i];
          if (!p.screen) continue;
          
          if (p.z < 0) {
            // Back-facing
            if (!inBackPath) {
              ctx.moveTo(p.screen.x, p.screen.y);
              inBackPath = true;
            } else {
              ctx.lineTo(p.screen.x, p.screen.y);
            }
          } else {
            inBackPath = false;
          }
        }
        ctx.stroke();
        
        // Draw front-facing parts (solid)
        ctx.strokeStyle = color;
        ctx.lineWidth = isHighlighted ? lineWidth + 2 : lineWidth;
        ctx.beginPath();
        let inFrontPath = false;
        
        for (let i = 0; i < transformedPoints.length; i++) {
          const p = transformedPoints[i];
          if (!p.screen) continue;
          
          if (p.z >= 0) {
            // Front-facing
            if (!inFrontPath) {
              ctx.moveTo(p.screen.x, p.screen.y);
              inFrontPath = true;
            } else {
              ctx.lineTo(p.screen.x, p.screen.y);
            }
          } else {
            inFrontPath = false;
          }
        }
        ctx.stroke();
        
        // Draw axis indicator at a front-facing point
        let labelPoint = null;
        const indicatorIndex = Math.floor(segments / 4);
        
        // Find a front-facing point near the indicator position
        for (let offset = 0; offset < segments / 2; offset++) {
          const idx1 = (indicatorIndex + offset) % segments;
          const idx2 = (indicatorIndex - offset + segments) % segments;
          
          if (transformedPoints[idx1]?.z >= 0 && transformedPoints[idx1]?.screen) {
            labelPoint = transformedPoints[idx1].screen;
            break;
          }
          if (transformedPoints[idx2]?.z >= 0 && transformedPoints[idx2]?.screen) {
            labelPoint = transformedPoints[idx2].screen;
            break;
          }
        }
        
        if (labelPoint) {
          ctx.fillStyle = color;
          ctx.font = 'bold 14px monospace';
          ctx.fillText(axis.toUpperCase(), labelPoint.x + 8, labelPoint.y + 4);
        }
      }
    },
    
    /**
     * Get current rotation quaternion
     * @returns {quat}
     */
    getRotation() {
      return quat.clone(modelRotation);
    },
    
    /**
     * Set rotation
     * @param {quat} rotation 
     */
    setRotation(rotation) {
      quat.copy(modelRotation, rotation);
    },
    
    /**
     * Reset rotation
     */
    reset() {
      quat.identity(modelRotation);
    },
    
    /**
     * Enable/disable gizmo
     * @param {boolean} value 
     */
    setEnabled(value) {
      enabled = value;
      if (!enabled) {
        hoveredAxis = null;
        dragAxis = null;
      }
    },
    
    /**
     * Check if currently dragging
     */
    isDragging() {
      return dragAxis !== null;
    },
    
    /**
     * Clean up
     */
    destroy() {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onDocumentMouseMove);
      document.removeEventListener('mouseup', onDocumentMouseUp);
    },
  };
}
