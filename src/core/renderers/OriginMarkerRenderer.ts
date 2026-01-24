/**
 * OriginMarkerRenderer - Renders the origin marker (orbit pivot point)
 * Displays as a crosshair with a dotted circle on the ground plane
 */

import { mat4, vec3 } from 'gl-matrix';

/**
 * Origin marker renderer for visualizing the orbit pivot point
 */
export class OriginMarkerRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;
  private initialized = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  }

  private init(): void {
    if (this.initialized) return;

    const gl = this.gl;

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

    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Create geometry: crosshair + dotted circle
    const vertices: number[] = [];
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

    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.initialized = true;
  }

  /**
   * Render the origin marker at the specified position
   * @param vpMatrix - View-projection matrix
   * @param originPos - Origin position [x, y, z]
   */
  render(vpMatrix: mat4, originPos: vec3 | number[]): void {
    if (!this.initialized) {
      this.init();
    }

    const gl = this.gl;
    gl.useProgram(this.program);

    const uViewProjection = gl.getUniformLocation(this.program!, 'uViewProjection');
    const uOrigin = gl.getUniformLocation(this.program!, 'uOrigin');
    const uColor = gl.getUniformLocation(this.program!, 'uColor');

    gl.uniformMatrix4fv(uViewProjection, false, vpMatrix);
    gl.uniform3fv(uOrigin, originPos as Float32List);
    gl.uniform3fv(uColor, [1.0, 0.8, 0.2]); // Yellow/orange color

    gl.bindVertexArray(this.vao);

    // Disable depth test so marker is always visible
    gl.disable(gl.DEPTH_TEST);

    // Draw crosshair (4 vertices = 2 lines)
    gl.drawArrays(gl.LINES, 0, 4);

    // Draw dotted circle (12 segments * 2 vertices each = 24 vertices)
    gl.drawArrays(gl.LINES, 4, 24);

    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    if (this.buffer) {
      gl.deleteBuffer(this.buffer);
      this.buffer = null;
    }
    if (this.vao) {
      gl.deleteVertexArray(this.vao);
      this.vao = null;
    }
    this.initialized = false;
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new OriginMarkerRenderer(gl)` instead
 */
export function createOriginMarkerRenderer(gl: WebGL2RenderingContext): OriginMarkerRenderer {
  return new OriginMarkerRenderer(gl);
}
