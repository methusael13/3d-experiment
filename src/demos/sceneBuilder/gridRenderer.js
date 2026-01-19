import { mat4 } from 'gl-matrix';

/**
 * Creates a grid floor and axis indicator renderer
 */
export function createGridRenderer(gl) {
  let gridProgram = null;
  let gridVAO = null;
  let gridVertexCount = 0;
  let axisVAO = null;
  let axisVertexCount = 0;
  let vpLocation = null;
  
  // Simple line shader
  const vsSource = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    in vec3 aColor;
    uniform mat4 uViewProjection;
    out vec3 vColor;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition, 1.0);
      vColor = aColor;
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
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Grid shader error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }
  
  function init() {
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    gridProgram = gl.createProgram();
    gl.attachShader(gridProgram, vs);
    gl.attachShader(gridProgram, fs);
    gl.linkProgram(gridProgram);
    
    vpLocation = gl.getUniformLocation(gridProgram, 'uViewProjection');
    
    const posLoc = gl.getAttribLocation(gridProgram, 'aPosition');
    const colorLoc = gl.getAttribLocation(gridProgram, 'aColor');
    
    // Create grid lines on XZ plane (skip center lines to avoid z-fighting with axes)
    const gridSize = 10;
    const gridStep = 1;
    const gridColor = [0.3, 0.3, 0.35]; // Dark grey
    const gridVertices = [];
    
    for (let i = -gridSize; i <= gridSize; i += gridStep) {
      if (i === 0) continue; // Skip center lines (axis lines will be drawn there)
      
      // Lines parallel to Z axis
      gridVertices.push(i, 0, -gridSize, ...gridColor);
      gridVertices.push(i, 0, gridSize, ...gridColor);
      // Lines parallel to X axis
      gridVertices.push(-gridSize, 0, i, ...gridColor);
      gridVertices.push(gridSize, 0, i, ...gridColor);
    }
    
    gridVertexCount = gridVertices.length / 6;
    
    gridVAO = gl.createVertexArray();
    gl.bindVertexArray(gridVAO);
    
    const gridBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gridVertices), gl.STATIC_DRAW);
    
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 24, 12);
    
    // Create axis lines
    const axisLength = 5;
    const axisVertices = [
      // X axis (red) - negative to positive
      -axisLength, 0, 0, 0.8, 0.2, 0.2,
      axisLength, 0, 0, 1.0, 0.3, 0.3,
      // Y axis (green) - negative to positive  
      0, -axisLength, 0, 0.2, 0.6, 0.2,
      0, axisLength, 0, 0.3, 0.9, 0.3,
      // Z axis (blue) - negative to positive
      0, 0, -axisLength, 0.2, 0.2, 0.8,
      0, 0, axisLength, 0.3, 0.3, 1.0,
    ];
    
    axisVertexCount = axisVertices.length / 6;
    
    axisVAO = gl.createVertexArray();
    gl.bindVertexArray(axisVAO);
    
    const axisBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, axisBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(axisVertices), gl.STATIC_DRAW);
    
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 24, 12);
    
    gl.bindVertexArray(null);
  }
  
  function render(vpMatrix, { showGrid = true, showAxes = true } = {}) {
    gl.useProgram(gridProgram);
    gl.uniformMatrix4fv(vpLocation, false, vpMatrix);
    
    // Draw grid
    if (showGrid) {
      gl.bindVertexArray(gridVAO);
      gl.drawArrays(gl.LINES, 0, gridVertexCount);
    }
    
    // Draw axes
    if (showAxes) {
      gl.bindVertexArray(axisVAO);
      gl.drawArrays(gl.LINES, 0, axisVertexCount);
    }
    
    gl.bindVertexArray(null);
  }
  
  function destroy() {
    if (gridProgram) gl.deleteProgram(gridProgram);
    if (gridVAO) gl.deleteVertexArray(gridVAO);
    if (axisVAO) gl.deleteVertexArray(axisVAO);
  }
  
  // Initialize on creation
  init();
  
  return { render, destroy };
}
