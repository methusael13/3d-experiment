/**
 * GridRenderer - Renders a grid floor and axis indicators
 */

import { mat4 } from 'gl-matrix';

export interface GridRenderOptions {
  showGrid?: boolean;
  showAxes?: boolean;
}

/**
 * Grid floor and axis renderer for scene visualization
 */
export class GridRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private gridVAO: WebGLVertexArrayObject;
  private axisVAO: WebGLVertexArrayObject;
  private gridVertexCount: number;
  private axisVertexCount: number;
  private vpLocation: WebGLUniformLocation | null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    
    // Compile shaders
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

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.vpLocation = gl.getUniformLocation(this.program, 'uViewProjection');

    const posLoc = gl.getAttribLocation(this.program, 'aPosition');
    const colorLoc = gl.getAttribLocation(this.program, 'aColor');

    // Create grid lines on XZ plane (skip center lines to avoid z-fighting with axes)
    const gridSize = 10;
    const gridStep = 1;
    const gridColor = [0.3, 0.3, 0.35]; // Dark grey
    const gridVertices: number[] = [];

    for (let i = -gridSize; i <= gridSize; i += gridStep) {
      if (i === 0) continue; // Skip center lines (axis lines will be drawn there)

      // Lines parallel to Z axis
      gridVertices.push(i, 0, -gridSize, ...gridColor);
      gridVertices.push(i, 0, gridSize, ...gridColor);
      // Lines parallel to X axis
      gridVertices.push(-gridSize, 0, i, ...gridColor);
      gridVertices.push(gridSize, 0, i, ...gridColor);
    }

    this.gridVertexCount = gridVertices.length / 6;

    this.gridVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.gridVAO);

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

    this.axisVertexCount = axisVertices.length / 6;

    this.axisVAO = gl.createVertexArray()!;
    gl.bindVertexArray(this.axisVAO);

    const axisBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, axisBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(axisVertices), gl.STATIC_DRAW);

    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(colorLoc, 3, gl.FLOAT, false, 24, 12);

    gl.bindVertexArray(null);
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Grid shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  render(vpMatrix: mat4, options: GridRenderOptions = {}): void {
    const { showGrid = true, showAxes = true } = options;
    const gl = this.gl;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.vpLocation, false, vpMatrix);

    // Draw grid
    if (showGrid) {
      gl.bindVertexArray(this.gridVAO);
      gl.drawArrays(gl.LINES, 0, this.gridVertexCount);
    }

    // Draw axes
    if (showAxes) {
      gl.bindVertexArray(this.axisVAO);
      gl.drawArrays(gl.LINES, 0, this.axisVertexCount);
    }

    gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.gridVAO);
    gl.deleteVertexArray(this.axisVAO);
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new GridRenderer(gl)` instead
 */
export function createGridRenderer(gl: WebGL2RenderingContext): GridRenderer {
  return new GridRenderer(gl);
}
