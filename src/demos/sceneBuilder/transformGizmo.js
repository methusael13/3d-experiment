import { mat4, vec3, quat } from 'gl-matrix';
import { screenToRay, rayPlaneIntersect } from './raycastUtils.js';

/**
 * Transform gizmo for translate, rotate, scale operations
 */
export function createTransformGizmo(gl, camera) {
  let mode = 'translate'; // 'translate' | 'rotate' | 'scale'
  let enabled = false;
  let targetPosition = [0, 0, 0];
  let targetRotation = [0, 0, 0];
  let targetScale = [1, 1, 1];
  
  // Callbacks
  let onTransformChange = null;
  let onUniformScaleOverlay = null; // Callback for rendering 2D overlay
  
  // Drag state
  let isDragging = false;
  let activeAxis = null; // 'x' | 'y' | 'z'
  let dragStartPos = [0, 0];
  let dragStartValue = 0;
  let lastDragPos = [0, 0]; // For incremental rotation
  
  // Arc-based rotation state
  let rotationLastAngle = 0; // Previous angle in rotation plane for incremental updates
  let storedCanvasWidth = 800;
  let storedCanvasHeight = 600;
  
  // Uniform scale state
  let uniformScaleActive = false;
  let uniformScaleStartScale = [1, 1, 1];
  let uniformScaleStartDistance = 0;
  let uniformScaleMousePos = [0, 0];
  let uniformScaleObjectScreenPos = [0, 0];
  let uniformScaleStartMousePos = [0, 0];
  let canvasWidth = 800;
  let canvasHeight = 600;
  
  // 2D overlay canvas for uniform scale visualization
  let overlayCanvas = null;
  let overlayCtx = null;
  let overlayContainer = null;
  
  // Gizmo shader
  const vsSource = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    uniform mat4 uViewProjection;
    uniform mat4 uModel;
    uniform vec3 uColor;
    out vec3 vColor;
    void main() {
      gl_Position = uViewProjection * uModel * vec4(aPosition, 1.0);
      vColor = uColor;
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    in vec3 vColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(vColor, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }
  
  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
  
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  
  const locations = {
    aPosition: gl.getAttribLocation(program, 'aPosition'),
    uViewProjection: gl.getUniformLocation(program, 'uViewProjection'),
    uModel: gl.getUniformLocation(program, 'uModel'),
    uColor: gl.getUniformLocation(program, 'uColor'),
  };
  
  // Create geometry buffers
  const axisLength = 1.0;
  const arrowSize = 0.05;
  const boxSize = 0.05;
  
  // Translate arrows (lines + cone tips)
  function createTranslateGeometry() {
    const vertices = [];
    
    // X axis line
    vertices.push(0, 0, 0, axisLength, 0, 0);
    // Y axis line
    vertices.push(0, 0, 0, 0, axisLength, 0);
    // Z axis line
    vertices.push(0, 0, 0, 0, 0, axisLength);
    
    return new Float32Array(vertices);
  }
  
  // Arrow heads (triangles)
  function createArrowHeads() {
    const s = arrowSize;
    const l = axisLength;
    const vertices = [];
    
    // X arrow (cone approximation as triangle fan)
    vertices.push(l + s * 2, 0, 0);
    vertices.push(l, s, 0);
    vertices.push(l, -s, 0);
    
    vertices.push(l + s * 2, 0, 0);
    vertices.push(l, 0, s);
    vertices.push(l, 0, -s);
    
    // Y arrow
    vertices.push(0, l + s * 2, 0);
    vertices.push(s, l, 0);
    vertices.push(-s, l, 0);
    
    vertices.push(0, l + s * 2, 0);
    vertices.push(0, l, s);
    vertices.push(0, l, -s);
    
    // Z arrow
    vertices.push(0, 0, l + s * 2);
    vertices.push(s, 0, l);
    vertices.push(-s, 0, l);
    
    vertices.push(0, 0, l + s * 2);
    vertices.push(0, s, l);
    vertices.push(0, -s, l);
    
    return new Float32Array(vertices);
  }
  
  // Scale boxes (cubes at axis ends)
  function createScaleGeometry() {
    const vertices = [];
    const s = boxSize;
    const l = axisLength;
    
    // Axis lines
    vertices.push(0, 0, 0, l, 0, 0);
    vertices.push(0, 0, 0, 0, l, 0);
    vertices.push(0, 0, 0, 0, 0, l);
    
    return new Float32Array(vertices);
  }
  
  function createScaleBoxes() {
    const s = boxSize;
    const l = axisLength;
    const vertices = [];
    
    // Helper to create box faces (as triangles)
    function addBox(cx, cy, cz) {
      // Front
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy - s, cz + s, cx + s, cy + s, cz + s);
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy + s, cz + s, cx - s, cy + s, cz + s);
      // Back
      vertices.push(cx + s, cy - s, cz - s, cx - s, cy - s, cz - s, cx - s, cy + s, cz - s);
      vertices.push(cx + s, cy - s, cz - s, cx - s, cy + s, cz - s, cx + s, cy + s, cz - s);
      // Top
      vertices.push(cx - s, cy + s, cz - s, cx - s, cy + s, cz + s, cx + s, cy + s, cz + s);
      vertices.push(cx - s, cy + s, cz - s, cx + s, cy + s, cz + s, cx + s, cy + s, cz - s);
      // Bottom
      vertices.push(cx - s, cy - s, cz + s, cx - s, cy - s, cz - s, cx + s, cy - s, cz - s);
      vertices.push(cx - s, cy - s, cz + s, cx + s, cy - s, cz - s, cx + s, cy - s, cz + s);
      // Right
      vertices.push(cx + s, cy - s, cz + s, cx + s, cy - s, cz - s, cx + s, cy + s, cz - s);
      vertices.push(cx + s, cy - s, cz + s, cx + s, cy + s, cz - s, cx + s, cy + s, cz + s);
      // Left
      vertices.push(cx - s, cy - s, cz - s, cx - s, cy - s, cz + s, cx - s, cy + s, cz + s);
      vertices.push(cx - s, cy - s, cz - s, cx - s, cy + s, cz + s, cx - s, cy + s, cz - s);
    }
    
    addBox(l, 0, 0); // X box
    addBox(0, l, 0); // Y box
    addBox(0, 0, l); // Z box
    
    return new Float32Array(vertices);
  }
  
  // Rotation circles
  function createRotateGeometry() {
    const segments = 32;
    const radius = axisLength * 0.8;
    const vertices = [];
    
    // X rotation circle (YZ plane)
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      vertices.push(0, Math.cos(a1) * radius, Math.sin(a1) * radius);
      vertices.push(0, Math.cos(a2) * radius, Math.sin(a2) * radius);
    }
    
    // Y rotation circle (XZ plane)
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      vertices.push(Math.cos(a1) * radius, 0, Math.sin(a1) * radius);
      vertices.push(Math.cos(a2) * radius, 0, Math.sin(a2) * radius);
    }
    
    // Z rotation circle (XY plane)
    for (let i = 0; i < segments; i++) {
      const a1 = (i / segments) * Math.PI * 2;
      const a2 = ((i + 1) / segments) * Math.PI * 2;
      vertices.push(Math.cos(a1) * radius, Math.sin(a1) * radius, 0);
      vertices.push(Math.cos(a2) * radius, Math.sin(a2) * radius, 0);
    }
    
    return new Float32Array(vertices);
  }
  
  // Create buffers
  const translateLinesBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, translateLinesBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, createTranslateGeometry(), gl.STATIC_DRAW);
  
  const arrowHeadsBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, arrowHeadsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, createArrowHeads(), gl.STATIC_DRAW);
  
  const scaleLinesBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, scaleLinesBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, createScaleGeometry(), gl.STATIC_DRAW);
  
  const scaleBoxesBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, scaleBoxesBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, createScaleBoxes(), gl.STATIC_DRAW);
  
  const rotateBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, rotateBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, createRotateGeometry(), gl.STATIC_DRAW);
  
  const modelMatrix = mat4.create();
  
  // Colors
  const xColor = [1.0, 0.2, 0.2]; // Red
  const yColor = [0.2, 0.9, 0.2]; // Green
  const zColor = [0.2, 0.4, 1.0]; // Blue
  
  // Highlighted colors (brighter when selected)
  const xColorHighlight = [1.0, 0.6, 0.0]; // Orange-yellow for X
  const yColorHighlight = [1.0, 1.0, 0.0]; // Yellow for Y
  const zColorHighlight = [0.0, 1.0, 1.0]; // Cyan for Z
  
  function getAxisColor(axis, baseColor, highlightColor) {
    return (isDragging && activeAxis === axis) ? highlightColor : baseColor;
  }
  
  function render(vpMatrix) {
    if (!enabled) return;
    
    // Position gizmo at target
    mat4.identity(modelMatrix);
    mat4.translate(modelMatrix, modelMatrix, targetPosition);
    
    gl.useProgram(program);
    gl.uniformMatrix4fv(locations.uViewProjection, false, vpMatrix);
    gl.uniformMatrix4fv(locations.uModel, false, modelMatrix);
    
    // Disable depth test and cull face so gizmo is always visible from all angles
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    
    if (mode === 'translate') {
      // Draw axis lines
      gl.bindBuffer(gl.ARRAY_BUFFER, translateLinesBuffer);
      gl.enableVertexAttribArray(locations.aPosition);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.uniform3fv(locations.uColor, getAxisColor('x', xColor, xColorHighlight));
      gl.drawArrays(gl.LINES, 0, 2);
      gl.uniform3fv(locations.uColor, getAxisColor('y', yColor, yColorHighlight));
      gl.drawArrays(gl.LINES, 2, 2);
      gl.uniform3fv(locations.uColor, getAxisColor('z', zColor, zColorHighlight));
      gl.drawArrays(gl.LINES, 4, 2);
      
      // Draw arrow heads
      gl.bindBuffer(gl.ARRAY_BUFFER, arrowHeadsBuffer);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.uniform3fv(locations.uColor, getAxisColor('x', xColor, xColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.uniform3fv(locations.uColor, getAxisColor('y', yColor, yColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 6, 6);
      gl.uniform3fv(locations.uColor, getAxisColor('z', zColor, zColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 12, 6);
      
    } else if (mode === 'scale') {
      // Draw axis lines
      gl.bindBuffer(gl.ARRAY_BUFFER, scaleLinesBuffer);
      gl.enableVertexAttribArray(locations.aPosition);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.uniform3fv(locations.uColor, getAxisColor('x', xColor, xColorHighlight));
      gl.drawArrays(gl.LINES, 0, 2);
      gl.uniform3fv(locations.uColor, getAxisColor('y', yColor, yColorHighlight));
      gl.drawArrays(gl.LINES, 2, 2);
      gl.uniform3fv(locations.uColor, getAxisColor('z', zColor, zColorHighlight));
      gl.drawArrays(gl.LINES, 4, 2);
      
      // Draw boxes
      gl.bindBuffer(gl.ARRAY_BUFFER, scaleBoxesBuffer);
      gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.uniform3fv(locations.uColor, getAxisColor('x', xColor, xColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 0, 36);
      gl.uniform3fv(locations.uColor, getAxisColor('y', yColor, yColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 36, 36);
      gl.uniform3fv(locations.uColor, getAxisColor('z', zColor, zColorHighlight));
      gl.drawArrays(gl.TRIANGLES, 72, 36);
      
    } else if (mode === 'rotate') {
      // Draw rotation circles with front/back distinction
      // We need to draw each segment individually with different colors based on facing
      const segments = 32;
      const radius = axisLength * 0.8;
      const camPos = camera.getPosition();
      
      const circleConfigs = [
        { 
          axis: 'x',
          color: xColor, 
          highlightColor: xColorHighlight,
          dimColor: [0.3, 0.1, 0.1], 
          getPoint: (a) => [0, Math.cos(a) * radius, Math.sin(a) * radius], 
          getNormal: (a) => [0, Math.cos(a), Math.sin(a)] 
        },
        { 
          axis: 'y',
          color: yColor, 
          highlightColor: yColorHighlight,
          dimColor: [0.1, 0.25, 0.1], 
          getPoint: (a) => [Math.cos(a) * radius, 0, Math.sin(a) * radius], 
          getNormal: (a) => [Math.cos(a), 0, Math.sin(a)] 
        },
        { 
          axis: 'z',
          color: zColor, 
          highlightColor: zColorHighlight,
          dimColor: [0.1, 0.15, 0.3], 
          getPoint: (a) => [Math.cos(a) * radius, Math.sin(a) * radius, 0], 
          getNormal: (a) => [Math.cos(a), Math.sin(a), 0] 
        },
      ];
      
      for (const config of circleConfigs) {
        for (let i = 0; i < segments; i++) {
          const a1 = (i / segments) * Math.PI * 2;
          const a2 = ((i + 1) / segments) * Math.PI * 2;
          
          const p1 = config.getPoint(a1);
          const p2 = config.getPoint(a2);
          const midAngle = (a1 + a2) / 2;
          const normal = config.getNormal(midAngle);
          
          // World position of midpoint
          const midWorld = [
            targetPosition[0] + (p1[0] + p2[0]) / 2,
            targetPosition[1] + (p1[1] + p2[1]) / 2,
            targetPosition[2] + (p1[2] + p2[2]) / 2
          ];
          
          // Check if front-facing
          const toCamera = [
            camPos[0] - midWorld[0],
            camPos[1] - midWorld[1],
            camPos[2] - midWorld[2]
          ];
          const dot = normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2];
          const isFront = dot > 0;
          
          // Create line segment buffer
          const lineData = new Float32Array([
            p1[0], p1[1], p1[2],
            p2[0], p2[1], p2[2]
          ]);
          
          const tempBuffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, tempBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, lineData, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(locations.aPosition);
          gl.vertexAttribPointer(locations.aPosition, 3, gl.FLOAT, false, 0, 0);
          
          const isSelected = isDragging && activeAxis === config.axis;
          let color;
          if (isSelected) {
            color = config.highlightColor;
          } else if (isFront) {
            color = config.color;
          } else {
            color = config.dimColor;
          }
          gl.uniform3fv(locations.uColor, color);
          gl.drawArrays(gl.LINES, 0, 2);
          
          gl.disableVertexAttribArray(locations.aPosition);
          gl.deleteBuffer(tempBuffer);
        }
      }
    }
    
    // Re-enable depth test and cull face
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    
    // Render 2D overlay for uniform scale
    renderUniformScaleOverlay();
  }
  
  function setMode(newMode) {
    mode = newMode;
  }
  
  function setTarget(position, rotation, scale) {
    targetPosition = [...position];
    targetRotation = [...rotation];
    targetScale = [...scale];
  }
  
  function setEnabled(value) {
    enabled = value;
  }
  
  function setOnChange(callback) {
    onTransformChange = callback;
  }
  
  // ==================== Arc-Based Rotation Helpers ====================
  
  /**
   * Get the rotation plane normal and basis vectors for an axis
   */
  function getRotationPlaneInfo(axis) {
    // Rotation plane normal is the axis itself
    // u and v are the two orthogonal vectors in the plane
    if (axis === 'x') {
      return {
        normal: [1, 0, 0],
        u: [0, 1, 0],  // Y direction in plane
        v: [0, 0, 1],  // Z direction in plane
      };
    } else if (axis === 'y') {
      return {
        normal: [0, 1, 0],
        u: [0, 0, 1],  // Z direction in plane
        v: [1, 0, 0],  // X direction in plane
      };
    } else { // z
      return {
        normal: [0, 0, 1],
        u: [1, 0, 0],  // X direction in plane
        v: [0, 1, 0],  // Y direction in plane
      };
    }
  }
  
  /**
   * Get the angle of a point in the rotation plane (relative to pivot)
   * Returns angle in degrees
   */
  function getAngleInPlane(point, pivot, axis) {
    const planeInfo = getRotationPlaneInfo(axis);
    
    // Vector from pivot to point
    const v = [
      point[0] - pivot[0],
      point[1] - pivot[1],
      point[2] - pivot[2],
    ];
    
    // Project onto plane basis vectors
    const uCoord = v[0] * planeInfo.u[0] + v[1] * planeInfo.u[1] + v[2] * planeInfo.u[2];
    const vCoord = v[0] * planeInfo.v[0] + v[1] * planeInfo.v[1] + v[2] * planeInfo.v[2];
    
    // Calculate angle using atan2
    return Math.atan2(vCoord, uCoord) * 180 / Math.PI;
  }
  
  /**
   * Project mouse position onto the rotation circle and get the angle
   * Returns null if projection fails (e.g., ray parallel to plane)
   */
  function getMouseAngleOnCircle(screenX, screenY, axis, cw, ch) {
    const { rayOrigin, rayDir } = screenToRay(screenX, screenY, camera, cw, ch);
    const planeInfo = getRotationPlaneInfo(axis);
    
    // Intersect ray with rotation plane (plane passes through target position)
    const intersection = rayPlaneIntersect(
      rayOrigin,
      rayDir,
      targetPosition,
      planeInfo.normal
    );
    
    if (!intersection) {
      // Fallback: use closest approach to the plane center
      // Project ray origin onto plane and use that direction
      return null;
    }
    
    // Get angle of intersection point relative to pivot
    return getAngleInPlane(intersection, targetPosition, axis);
  }
  
  // ==================== Mouse Interaction ====================
  
  // Mouse interaction
  function handleMouseDown(screenX, screenY, cw, ch) {
    if (!enabled) return false;
    
    // Store canvas dimensions for later use
    storedCanvasWidth = cw;
    storedCanvasHeight = ch;
    
    // Check if clicking on a gizmo axis
    const axis = hitTestAxis(screenX, screenY, cw, ch);
    if (axis) {
      isDragging = true;
      activeAxis = axis;
      dragStartPos = [screenX, screenY];
      lastDragPos = [screenX, screenY];
      
      if (mode === 'translate') {
        dragStartValue = targetPosition[{ x: 0, y: 1, z: 2 }[axis]];
      } else if (mode === 'rotate') {
        // Get initial angle on the rotation circle
        const angle = getMouseAngleOnCircle(screenX, screenY, axis, cw, ch);
        if (angle !== null) {
          rotationLastAngle = angle;
        } else {
          // Fallback if we can't get a good angle
          rotationLastAngle = 0;
        }
        dragStartValue = 0;
      } else if (mode === 'scale') {
        dragStartValue = targetScale[{ x: 0, y: 1, z: 2 }[axis]];
      }
      return true;
    }
    return false;
  }
  
  function handleMouseMove(screenX, screenY) {
    if (!isDragging || !activeAxis) return false;
    
    const axisIndex = { x: 0, y: 1, z: 2 }[activeAxis];
    
    if (mode === 'translate') {
      const dx = screenX - dragStartPos[0];
      const dy = screenY - dragStartPos[1];
      const delta = (dx - dy) * 0.01;
      targetPosition[axisIndex] = dragStartValue + delta;
      if (onTransformChange) onTransformChange('position', [...targetPosition]);
    } else if (mode === 'rotate') {
      // Arc-based rotation: calculate angle delta from mouse position on the rotation circle
      const currentAngle = getMouseAngleOnCircle(screenX, screenY, activeAxis, storedCanvasWidth, storedCanvasHeight);
      
      if (currentAngle !== null) {
        // Calculate signed angle difference (handles wraparound at ±180°)
        let deltaAngle = currentAngle - rotationLastAngle;
        
        // Handle wraparound: if delta is > 180 or < -180, it wrapped around
        if (deltaAngle > 180) {
          deltaAngle -= 360;
        } else if (deltaAngle < -180) {
          deltaAngle += 360;
        }
        
        // Apply rotation delta
        targetRotation[axisIndex] += deltaAngle;
        
        // Update last angle for next frame
        rotationLastAngle = currentAngle;
        
        if (onTransformChange) onTransformChange('rotation', [...targetRotation]);
      } else {
        // Fallback: ray was parallel to plane, use screen-space delta
        const dx = screenX - lastDragPos[0];
        const dy = screenY - lastDragPos[1];
        const deltaAngle = (dx + dy) * 0.5;
        targetRotation[axisIndex] += deltaAngle;
        if (onTransformChange) onTransformChange('rotation', [...targetRotation]);
      }
      
      lastDragPos = [screenX, screenY];
    } else if (mode === 'scale') {
      const dx = screenX - dragStartPos[0];
      const dy = screenY - dragStartPos[1];
      const delta = (dx - dy) * 0.01;
      targetScale[axisIndex] = Math.max(0.01, dragStartValue + delta);
      if (onTransformChange) onTransformChange('scale', [...targetScale]);
    }
    
    return true;
  }
  
  function handleMouseUp() {
    isDragging = false;
    activeAxis = null;
  }
  
  function hitTestAxis(screenX, screenY, canvasWidth, canvasHeight) {
    const vpMatrix = camera.getViewProjectionMatrix();
    
    if (mode === 'translate' || mode === 'scale') {
      // For translate/scale, check axis endpoints
      const axes = [
        { name: 'x', end: [targetPosition[0] + axisLength, targetPosition[1], targetPosition[2]] },
        { name: 'y', end: [targetPosition[0], targetPosition[1] + axisLength, targetPosition[2]] },
        { name: 'z', end: [targetPosition[0], targetPosition[1], targetPosition[2] + axisLength] },
      ];
      
      for (const axis of axes) {
        const screenPos = projectToScreen(axis.end, vpMatrix, canvasWidth, canvasHeight);
        const distance = Math.sqrt((screenX - screenPos[0]) ** 2 + (screenY - screenPos[1]) ** 2);
        if (distance < 30) { // 30 pixel radius
          return axis.name;
        }
      }
    } else if (mode === 'rotate') {
      // For rotation, check along the circle segments (only front-facing)
      const radius = axisLength * 0.8;
      const segments = 16;
      const hitRadius = 20; // pixels
      
      // Get camera position for front-face detection
      const camPos = camera.getPosition();
      
      const circleAxes = [
        { 
          name: 'x', 
          getPoint: (angle) => [targetPosition[0], targetPosition[1] + Math.cos(angle) * radius, targetPosition[2] + Math.sin(angle) * radius],
          getNormal: (angle) => [0, Math.cos(angle), Math.sin(angle)] // normal points outward on YZ plane
        },
        { 
          name: 'y', 
          getPoint: (angle) => [targetPosition[0] + Math.cos(angle) * radius, targetPosition[1], targetPosition[2] + Math.sin(angle) * radius],
          getNormal: (angle) => [Math.cos(angle), 0, Math.sin(angle)]
        },
        { 
          name: 'z', 
          getPoint: (angle) => [targetPosition[0] + Math.cos(angle) * radius, targetPosition[1] + Math.sin(angle) * radius, targetPosition[2]],
          getNormal: (angle) => [Math.cos(angle), Math.sin(angle), 0]
        },
      ];
      
      for (const axis of circleAxes) {
        for (let i = 0; i < segments; i++) {
          const angle = (i / segments) * Math.PI * 2;
          const worldPos = axis.getPoint(angle);
          const normal = axis.getNormal(angle);
          
          // Check if this point is front-facing (normal points toward camera)
          const toCamera = [
            camPos[0] - worldPos[0],
            camPos[1] - worldPos[1],
            camPos[2] - worldPos[2]
          ];
          const dot = normal[0] * toCamera[0] + normal[1] * toCamera[1] + normal[2] * toCamera[2];
          
          // Only allow interaction with front-facing parts
          if (dot > 0) {
            const screenPos = projectToScreen(worldPos, vpMatrix, canvasWidth, canvasHeight);
            const distance = Math.sqrt((screenX - screenPos[0]) ** 2 + (screenY - screenPos[1]) ** 2);
            if (distance < hitRadius) {
              return axis.name;
            }
          }
        }
      }
    }
    
    return null;
  }
  
  function projectToScreen(worldPos, vpMatrix, canvasWidth, canvasHeight) {
    const clipPos = [0, 0, 0, 1];
    const pos4 = [worldPos[0], worldPos[1], worldPos[2], 1];
    
    clipPos[0] = vpMatrix[0] * pos4[0] + vpMatrix[4] * pos4[1] + vpMatrix[8] * pos4[2] + vpMatrix[12] * pos4[3];
    clipPos[1] = vpMatrix[1] * pos4[0] + vpMatrix[5] * pos4[1] + vpMatrix[9] * pos4[2] + vpMatrix[13] * pos4[3];
    clipPos[2] = vpMatrix[2] * pos4[0] + vpMatrix[6] * pos4[1] + vpMatrix[10] * pos4[2] + vpMatrix[14] * pos4[3];
    clipPos[3] = vpMatrix[3] * pos4[0] + vpMatrix[7] * pos4[1] + vpMatrix[11] * pos4[2] + vpMatrix[15] * pos4[3];
    
    if (clipPos[3] !== 0) {
      clipPos[0] /= clipPos[3];
      clipPos[1] /= clipPos[3];
    }
    
    const screenX = (clipPos[0] * 0.5 + 0.5) * canvasWidth;
    const screenY = (1 - (clipPos[1] * 0.5 + 0.5)) * canvasHeight;
    
    return [screenX, screenY];
  }
  
  // ==================== Uniform Scale Mode ====================
  
  /**
   * Sets the overlay container element
   * @param {HTMLElement} container - Container element to append overlay to
   */
  function setOverlayContainer(container) {
    overlayContainer = container;
  }
  
  /**
   * Sets canvas dimensions for uniform scale calculations
   */
  function setCanvasSize(width, height) {
    canvasWidth = width;
    canvasHeight = height;
    
    // Update overlay canvas size if it exists
    if (overlayCanvas) {
      overlayCanvas.width = width;
      overlayCanvas.height = height;
    }
  }
  
  /**
   * Creates the overlay canvas if needed
   */
  function ensureOverlayCanvas() {
    if (!overlayCanvas) {
      overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = canvasWidth;
      overlayCanvas.height = canvasHeight;
      overlayCanvas.style.cssText = 'position: absolute; pointer-events: none; top: 0; left: 0; background: transparent;';
      overlayCtx = overlayCanvas.getContext('2d');
    }
  }
  
  /**
   * Renders the uniform scale overlay (called from render())
   */
  function renderUniformScaleOverlay() {
    if (!overlayCanvas || !overlayCtx) return;
    
    overlayCtx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    if (!uniformScaleActive) {
      // Remove canvas when not active
      if (overlayCanvas.parentNode) {
        overlayCanvas.parentNode.removeChild(overlayCanvas);
      }
      return;
    }
    
    // Ensure canvas is in DOM
    if (overlayContainer && !overlayCanvas.parentNode) {
      overlayContainer.appendChild(overlayCanvas);
    }
    
    // Draw line from object to mouse
    overlayCtx.save();
    overlayCtx.strokeStyle = '#ffff00';
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([8, 8]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(uniformScaleObjectScreenPos[0], uniformScaleObjectScreenPos[1]);
    overlayCtx.lineTo(uniformScaleMousePos[0], uniformScaleMousePos[1]);
    overlayCtx.stroke();
    
    // Draw center point
    overlayCtx.fillStyle = '#ffff00';
    overlayCtx.beginPath();
    overlayCtx.arc(uniformScaleObjectScreenPos[0], uniformScaleObjectScreenPos[1], 6, 0, Math.PI * 2);
    overlayCtx.fill();
    
    // Draw instructions
    overlayCtx.fillStyle = '#ffffff';
    overlayCtx.font = '12px monospace';
    overlayCtx.fillText('Uniform Scale - Click to commit, Esc to cancel', 10, 20);
    overlayCtx.restore();
  }
  
  /**
   * Starts uniform scale mode
   * @param {Array} startScale - Current scale [x, y, z]
   * @param {Array} objectScreenPosition - Screen position of object center
   * @param {Array} mousePosition - Current mouse position
   * @returns {boolean} - True if uniform scale started successfully
   */
  function startUniformScale(startScale, objectScreenPosition, mousePosition) {
    if (!enabled) return false;
    
    uniformScaleActive = true;
    uniformScaleStartScale = [...startScale];
    uniformScaleObjectScreenPos = [...objectScreenPosition];
    uniformScaleStartMousePos = [...mousePosition];
    uniformScaleMousePos = [...mousePosition];
    
    const dx = uniformScaleStartMousePos[0] - uniformScaleObjectScreenPos[0];
    const dy = uniformScaleStartMousePos[1] - uniformScaleObjectScreenPos[1];
    uniformScaleStartDistance = Math.sqrt(dx * dx + dy * dy);
    if (uniformScaleStartDistance < 10) uniformScaleStartDistance = 100;
    
    ensureOverlayCanvas();
    return true;
  }
  
  /**
   * Updates uniform scale based on mouse position
   * @param {number} mouseX - Current mouse X
   * @param {number} mouseY - Current mouse Y
   * @returns {Array|null} - New scale values [x, y, z] or null if not active
   */
  function updateUniformScale(mouseX, mouseY) {
    if (!uniformScaleActive) return null;
    
    uniformScaleMousePos = [mouseX, mouseY];
    
    const dx = mouseX - uniformScaleObjectScreenPos[0];
    const dy = mouseY - uniformScaleObjectScreenPos[1];
    const scaleFactor = Math.sqrt(dx * dx + dy * dy) / uniformScaleStartDistance;
    
    return uniformScaleStartScale.map(s => Math.max(0.01, s * scaleFactor));
  }
  
  /**
   * Commits uniform scale (ends the mode)
   */
  function commitUniformScale() {
    uniformScaleActive = false;
  }
  
  /**
   * Cancels uniform scale and returns original scale
   * @returns {Array} - Original start scale
   */
  function cancelUniformScale() {
    const originalScale = [...uniformScaleStartScale];
    uniformScaleActive = false;
    return originalScale;
  }
  
  function destroy() {
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(translateLinesBuffer);
    gl.deleteBuffer(arrowHeadsBuffer);
    gl.deleteBuffer(scaleLinesBuffer);
    gl.deleteBuffer(scaleBoxesBuffer);
    gl.deleteBuffer(rotateBuffer);
  }
  
  return {
    render,
    setMode,
    setTarget,
    setEnabled,
    setOnChange,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    destroy,
    // Uniform scale
    setCanvasSize,
    setOverlayContainer,
    startUniformScale,
    updateUniformScale,
    commitUniformScale,
    cancelUniformScale,
    get isDragging() { return isDragging; },
    get mode() { return mode; },
    get isUniformScaleActive() { return uniformScaleActive; },
  };
}
