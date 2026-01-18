import { mat4 } from 'gl-matrix';

const VERTEX_SHADER = `#version 300 es
  precision highp float;
  
  in vec3 aPosition;
  uniform mat4 uModelViewProjection;
  
  void main() {
    gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
  }
`;

const FRAGMENT_SHADER = `#version 300 es
  precision mediump float;
  
  uniform vec3 uColor;
  out vec4 fragColor;
  
  void main() {
    fragColor = vec4(uColor, 1.0);
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? [
    parseInt(result[1], 16) / 255,
    parseInt(result[2], 16) / 255,
    parseInt(result[3], 16) / 255
  ] : [1, 0, 0];
}

/**
 * Creates a pure WebGL wireframe renderer
 * Only responsible for rendering - no animation loop or controls
 * 
 * @param {HTMLCanvasElement} canvas 
 * @param {object} model - { vertices: [{x,y,z}...], edges: [[i,j]...] }
 * @param {object} options - Optional configuration
 * @returns {object} { render(viewProjectionMatrix, modelMatrix), destroy() }
 */
export function createWebGLRenderer(canvas, model, options = {}) {
  const gl = canvas.getContext('webgl2');
  
  if (!gl) {
    console.error('WebGL 2 not supported');
    return null;
  }
  
  const {
    foreground = '#ff0000',
    background = '#0d0d0d',
  } = options;
  
  const bgColor = hexToRgb(background);
  const fgColor = hexToRgb(foreground);
  
  // Create shaders and program
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = createProgram(gl, vertexShader, fragmentShader);
  
  // Get attribute and uniform locations
  const aPosition = gl.getAttribLocation(program, 'aPosition');
  const uModelViewProjection = gl.getUniformLocation(program, 'uModelViewProjection');
  const uColor = gl.getUniformLocation(program, 'uColor');
  
  // Create vertex buffer from edges
  const lineVertices = [];
  for (const [i, j] of model.edges) {
    const v1 = model.vertices[i];
    const v2 = model.vertices[j];
    lineVertices.push(v1.x, v1.y, v1.z);
    lineVertices.push(v2.x, v2.y, v2.z);
  }
  
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineVertices), gl.STATIC_DRAW);
  
  const vertexCount = lineVertices.length / 3;
  
  // MVP matrix for combining
  const mvpMatrix = mat4.create();
  
  // Set initial GL state
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(bgColor[0], bgColor[1], bgColor[2], 1.0);
  
  return {
    /**
     * Render a single frame
     * @param {mat4} viewProjectionMatrix - Combined view-projection matrix
     * @param {mat4} modelMatrix - Model transformation matrix
     */
    render(viewProjectionMatrix, modelMatrix) {
      // Combine matrices: viewProjection * model
      mat4.multiply(mvpMatrix, viewProjectionMatrix, modelMatrix);
      
      // Clear
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      
      // Use program
      gl.useProgram(program);
      
      // Set uniforms
      gl.uniformMatrix4fv(uModelViewProjection, false, mvpMatrix);
      gl.uniform3fv(uColor, fgColor);
      
      // Bind vertex buffer and set attribute
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.enableVertexAttribArray(aPosition);
      gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
      
      // Draw lines
      gl.drawArrays(gl.LINES, 0, vertexCount);
    },
    
    /**
     * Clean up WebGL resources
     */
    destroy() {
      gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    },
  };
}
