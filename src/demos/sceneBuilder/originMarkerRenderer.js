/**
 * Renders the origin marker (orbit pivot point)
 * Displays as a crosshair with a dotted circle on the ground plane
 */
export function createOriginMarkerRenderer(gl) {
  let program = null;
  let vao = null;
  let buffer = null;
  
  const vsSource = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    uniform mat4 uViewProjection;
    uniform vec3 uOrigin;
    void main() {
      gl_Position = uViewProjection * vec4(aPosition + uOrigin, 1.0);
    }
  `;
  
  const fsSource = `#version 300 es
    precision mediump float;
    uniform vec3 uColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(uColor, 1.0);
    }
  `;
  
  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }
  
  function init() {
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    
    // Create geometry: crosshair + dotted circle
    const vertices = [];
    const crosshairSize = 0.15;
    const circleRadius = 0.25;
    const circleSegments = 24;
    
    // Crosshair (X shape on XZ plane at Y=0.01 to avoid z-fighting)
    const y = 0.01;
    vertices.push(-crosshairSize, y, 0, crosshairSize, y, 0); // X line
    vertices.push(0, y, -crosshairSize, 0, y, crosshairSize); // Z line
    
    // Dotted circle (every other segment)
    for (let i = 0; i < circleSegments; i += 2) {
      const a1 = (i / circleSegments) * Math.PI * 2;
      const a2 = ((i + 1) / circleSegments) * Math.PI * 2;
      vertices.push(
        Math.cos(a1) * circleRadius, y, Math.sin(a1) * circleRadius,
        Math.cos(a2) * circleRadius, y, Math.sin(a2) * circleRadius
      );
    }
    
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }
  
  function render(vpMatrix, originPos) {
    if (!program) {
      init();
    }
    
    gl.useProgram(program);
    
    const uViewProjection = gl.getUniformLocation(program, 'uViewProjection');
    const uOrigin = gl.getUniformLocation(program, 'uOrigin');
    const uColor = gl.getUniformLocation(program, 'uColor');
    
    gl.uniformMatrix4fv(uViewProjection, false, vpMatrix);
    gl.uniform3fv(uOrigin, originPos);
    gl.uniform3fv(uColor, [1.0, 0.8, 0.2]); // Yellow/orange color
    
    gl.bindVertexArray(vao);
    
    // Disable depth test so marker is always visible
    gl.disable(gl.DEPTH_TEST);
    
    // Draw crosshair (4 vertices = 2 lines)
    gl.drawArrays(gl.LINES, 0, 4);
    
    // Draw dotted circle (12 segments * 2 vertices each = 24 vertices)
    gl.drawArrays(gl.LINES, 4, 24);
    
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
  
  function destroy() {
    if (program) {
      gl.deleteProgram(program);
      program = null;
    }
    if (buffer) {
      gl.deleteBuffer(buffer);
      buffer = null;
    }
    if (vao) {
      gl.deleteVertexArray(vao);
      vao = null;
    }
  }
  
  return {
    render,
    destroy,
  };
}
