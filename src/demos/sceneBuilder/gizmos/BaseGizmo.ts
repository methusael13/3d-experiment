/**
 * BaseGizmo - Abstract base class for all transform gizmos
 * Provides shared shader, screen-space scaling, and common utilities
 */

import { mat4, vec3 } from 'gl-matrix';

/**
 * Camera interface for gizmo rendering
 */
export interface GizmoCamera {
  getPosition(): [number, number, number];
  getViewProjectionMatrix(): mat4;
  getFOV?(): number;
}

/**
 * Callback type for transform changes
 */
export type TransformChangeCallback = (type: 'position' | 'rotation' | 'scale', value: [number, number, number]) => void;

/**
 * Gizmo axis type
 */
export type GizmoAxis = 'x' | 'y' | 'z' | null;

/**
 * Colors for gizmo axes
 */
export const AXIS_COLORS = {
  x: [1.0, 0.2, 0.2] as [number, number, number],      // Red
  y: [0.2, 0.9, 0.2] as [number, number, number],      // Green
  z: [0.2, 0.4, 1.0] as [number, number, number],      // Blue
  xHighlight: [1.0, 0.6, 0.0] as [number, number, number],  // Orange
  yHighlight: [1.0, 1.0, 0.0] as [number, number, number],  // Yellow
  zHighlight: [0.0, 1.0, 1.0] as [number, number, number],  // Cyan
  xDim: [0.3, 0.1, 0.1] as [number, number, number],
  yDim: [0.1, 0.25, 0.1] as [number, number, number],
  zDim: [0.1, 0.15, 0.3] as [number, number, number],
};

/**
 * Shared shader locations interface
 */
export interface GizmoShaderLocations {
  aPosition: number;
  uViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/**
 * Abstract base class for transform gizmos
 */
export abstract class BaseGizmo {
  protected readonly gl: WebGL2RenderingContext;
  protected readonly camera: GizmoCamera;
  
  // Shared shader (static, created once)
  protected static shaderProgram: WebGLProgram | null = null;
  protected static shaderLocations: GizmoShaderLocations | null = null;
  protected static shaderRefCount = 0;
  
  // Target transform
  protected targetPosition: [number, number, number] = [0, 0, 0];
  protected targetRotation: [number, number, number] = [0, 0, 0];
  protected targetScale: [number, number, number] = [1, 1, 1];
  
  // State
  protected enabled = false;
  protected isDraggingFlag = false;
  protected activeAxis: GizmoAxis = null;
  
  // Canvas dimensions for hit testing
  protected canvasWidth = 800;
  protected canvasHeight = 600;
  
  // Callbacks
  protected onTransformChange: TransformChangeCallback | null = null;
  
  // Reusable model matrix
  protected readonly modelMatrix = mat4.create();
  
  // Screen-space scale configuration
  protected static readonly BASE_SCREEN_SIZE = 100; // Base size in pixels
  protected static readonly DEFAULT_FOV = Math.PI / 4; // 45 degrees
  
  constructor(gl: WebGL2RenderingContext, camera: GizmoCamera) {
    this.gl = gl;
    this.camera = camera;
    
    // Initialize shared shader
    BaseGizmo.shaderRefCount++;
    if (!BaseGizmo.shaderProgram) {
      this.createSharedShader();
    }
  }
  
  /**
   * Create the shared shader program
   */
  private createSharedShader(): void {
    const gl = this.gl;
    
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
    
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Gizmo shader link error:', gl.getProgramInfoLog(program));
    }
    
    // Clean up individual shaders
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    
    BaseGizmo.shaderProgram = program;
    BaseGizmo.shaderLocations = {
      aPosition: gl.getAttribLocation(program, 'aPosition'),
      uViewProjection: gl.getUniformLocation(program, 'uViewProjection'),
      uModel: gl.getUniformLocation(program, 'uModel'),
      uColor: gl.getUniformLocation(program, 'uColor'),
    };
  }
  
  /**
   * Compile a shader
   */
  protected compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Gizmo shader error:', gl.getShaderInfoLog(shader));
    }
    
    return shader;
  }
  
  /**
   * Calculate screen-space scale factor to keep gizmo constant pixel size
   */
  protected getScreenSpaceScale(): number {
    const cameraPos = this.camera.getPosition();
    const distance = vec3.distance(
      cameraPos as unknown as vec3,
      this.targetPosition as unknown as vec3
    );
    
    // Get FOV (use default if not available)
    const fov = this.camera.getFOV?.() ?? BaseGizmo.DEFAULT_FOV;
    
    // Calculate world-space size that appears as BASE_SCREEN_SIZE pixels
    const worldUnitsPerPixel = (2 * distance * Math.tan(fov / 2)) / this.canvasHeight;
    return worldUnitsPerPixel * BaseGizmo.BASE_SCREEN_SIZE;
  }
  
  /**
   * Set up model matrix with screen-space scaling
   */
  protected setupModelMatrix(): void {
    mat4.identity(this.modelMatrix);
    mat4.translate(this.modelMatrix, this.modelMatrix, this.targetPosition as unknown as vec3);
    
    const scale = this.getScreenSpaceScale();
    mat4.scale(this.modelMatrix, this.modelMatrix, [scale, scale, scale]);
  }
  
  /**
   * Begin rendering - use shader and set common uniforms
   */
  protected beginRender(vpMatrix: mat4): void {
    const gl = this.gl;
    const loc = BaseGizmo.shaderLocations!;
    
    gl.useProgram(BaseGizmo.shaderProgram);
    gl.uniformMatrix4fv(loc.uViewProjection, false, vpMatrix);
    
    this.setupModelMatrix();
    gl.uniformMatrix4fv(loc.uModel, false, this.modelMatrix);
    
    // Disable depth test so gizmo is always visible
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }
  
  /**
   * End rendering - restore GL state
   */
  protected endRender(): void {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }
  
  /**
   * Set color uniform
   */
  protected setColor(color: [number, number, number]): void {
    const loc = BaseGizmo.shaderLocations!;
    this.gl.uniform3fv(loc.uColor, color);
  }
  
  /**
   * Get color for axis based on drag state
   */
  protected getAxisColor(axis: 'x' | 'y' | 'z'): [number, number, number] {
    if (this.isDraggingFlag && this.activeAxis === axis) {
      return AXIS_COLORS[`${axis}Highlight` as keyof typeof AXIS_COLORS] as [number, number, number];
    }
    return AXIS_COLORS[axis];
  }
  
  /**
   * Project world position to screen coordinates
   */
  protected projectToScreen(worldPos: [number, number, number]): [number, number] {
    const vpMatrix = this.camera.getViewProjectionMatrix();
    const pos4 = [worldPos[0], worldPos[1], worldPos[2], 1];
    
    const clipPos = [0, 0, 0, 1];
    clipPos[0] = vpMatrix[0] * pos4[0] + vpMatrix[4] * pos4[1] + vpMatrix[8] * pos4[2] + vpMatrix[12] * pos4[3];
    clipPos[1] = vpMatrix[1] * pos4[0] + vpMatrix[5] * pos4[1] + vpMatrix[9] * pos4[2] + vpMatrix[13] * pos4[3];
    clipPos[2] = vpMatrix[2] * pos4[0] + vpMatrix[6] * pos4[1] + vpMatrix[10] * pos4[2] + vpMatrix[14] * pos4[3];
    clipPos[3] = vpMatrix[3] * pos4[0] + vpMatrix[7] * pos4[1] + vpMatrix[11] * pos4[2] + vpMatrix[15] * pos4[3];
    
    if (clipPos[3] !== 0) {
      clipPos[0] /= clipPos[3];
      clipPos[1] /= clipPos[3];
    }
    
    const screenX = (clipPos[0] * 0.5 + 0.5) * this.canvasWidth;
    const screenY = (1 - (clipPos[1] * 0.5 + 0.5)) * this.canvasHeight;
    
    return [screenX, screenY];
  }
  
  /**
   * Get world position for axis endpoint (in screen-space scaled coordinates)
   */
  protected getAxisEndpoint(axis: 'x' | 'y' | 'z', length = 1.0): [number, number, number] {
    const scale = this.getScreenSpaceScale();
    const scaledLength = length * scale;
    
    switch (axis) {
      case 'x':
        return [this.targetPosition[0] + scaledLength, this.targetPosition[1], this.targetPosition[2]];
      case 'y':
        return [this.targetPosition[0], this.targetPosition[1] + scaledLength, this.targetPosition[2]];
      case 'z':
        return [this.targetPosition[0], this.targetPosition[1], this.targetPosition[2] + scaledLength];
    }
  }
  
  // ==================== Public API ====================
  
  /**
   * Set gizmo enabled state
   */
  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      this.isDraggingFlag = false;
      this.activeAxis = null;
    }
  }
  
  /**
   * Set target transform
   */
  setTarget(position: [number, number, number], rotation: [number, number, number], scale: [number, number, number]): void {
    this.targetPosition = [...position];
    this.targetRotation = [...rotation];
    this.targetScale = [...scale];
  }
  
  /**
   * Set canvas dimensions for hit testing
   */
  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }
  
  /**
   * Set transform change callback
   */
  setOnChange(callback: TransformChangeCallback | null): void {
    this.onTransformChange = callback;
  }
  
  /**
   * Get current dragging state
   */
  get isDragging(): boolean {
    return this.isDraggingFlag;
  }
  
  /**
   * Get current target position
   */
  getTargetPosition(): [number, number, number] {
    return [...this.targetPosition];
  }
  
  // ==================== Abstract Methods ====================
  
  /**
   * Render the gizmo
   */
  abstract render(vpMatrix: mat4): void;
  
  /**
   * Handle mouse down - returns true if gizmo was hit
   */
  abstract handleMouseDown(screenX: number, screenY: number): boolean;
  
  /**
   * Handle mouse move - returns true if drag was handled
   */
  abstract handleMouseMove(screenX: number, screenY: number): boolean;
  
  /**
   * Handle mouse up
   */
  abstract handleMouseUp(): void;
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    BaseGizmo.shaderRefCount--;
    
    // Only delete shared shader when last gizmo is destroyed
    if (BaseGizmo.shaderRefCount === 0 && BaseGizmo.shaderProgram) {
      this.gl.deleteProgram(BaseGizmo.shaderProgram);
      BaseGizmo.shaderProgram = null;
      BaseGizmo.shaderLocations = null;
    }
  }
}
