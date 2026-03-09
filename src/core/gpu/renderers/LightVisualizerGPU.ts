/**
 * LightVisualizerGPU — Renders wireframe helper shapes for light entities.
 *
 * Visualisations (only for the selected light entity):
 * - Directional: arrow indicating light direction (subtle gray)
 * - Point: small wireframe sphere at position (subtle gray)
 * - Spot: wireframe cone from position along direction + small sphere at base (subtle gray)
 *
 * Reuses gizmo.wgsl (unlit colored geometry, line-list topology).
 * Called from Viewport overlay pass after the main pipeline.
 */

import { vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, type VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import type { World } from '../../ecs/World';
import { LightComponent } from '../../ecs/components/LightComponent';
import { TransformComponent } from '../../ecs/components/TransformComponent';

import gizmoShader from '../shaders/gizmo.wgsl?raw';

/** Uniform size: VP(64) + model(64) + color(16) = 144 bytes — matches gizmo.wgsl */
const UNIFORM_SIZE = 144;

/** Max light helpers we pre-allocate pool slots for */
const MAX_HELPERS = 32;

/** Subtle dark gray color for all light helpers (non-distracting) */
const HELPER_COLOR: [number, number, number, number] = [0.45, 0.45, 0.45, 1.0];

/** Small handle sphere radius for point light and spot base */
const HANDLE_SPHERE_RADIUS = 0.3;

/**
 * Generate wireframe circle vertices (line-list) in the XZ plane.
 * @returns flat array of floats [x,y,z, x,y,z, ...]
 */
function generateCircle(center: vec3, radius: number, normal: vec3, segments: number): number[] {
  const lines: number[] = [];

  // Build a local frame from the normal
  let up: vec3 = [0, 1, 0];
  if (Math.abs(vec3.dot(normal, up)) > 0.99) up = [0, 0, 1];
  const tangent = vec3.create();
  vec3.cross(tangent, normal, up);
  vec3.normalize(tangent, tangent);
  const bitangent = vec3.create();
  vec3.cross(bitangent, normal, tangent);
  vec3.normalize(bitangent, bitangent);

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0: vec3 = [
      center[0] + (Math.cos(a0) * tangent[0] + Math.sin(a0) * bitangent[0]) * radius,
      center[1] + (Math.cos(a0) * tangent[1] + Math.sin(a0) * bitangent[1]) * radius,
      center[2] + (Math.cos(a0) * tangent[2] + Math.sin(a0) * bitangent[2]) * radius,
    ];
    const p1: vec3 = [
      center[0] + (Math.cos(a1) * tangent[0] + Math.sin(a1) * bitangent[0]) * radius,
      center[1] + (Math.cos(a1) * tangent[1] + Math.sin(a1) * bitangent[1]) * radius,
      center[2] + (Math.cos(a1) * tangent[2] + Math.sin(a1) * bitangent[2]) * radius,
    ];
    lines.push(...p0, ...p1);
  }
  return lines;
}

/**
 * Generate a wireframe sphere (3 orthogonal circles).
 */
function generateWireSphere(center: vec3, radius: number, segments = 24): number[] {
  return [
    ...generateCircle(center, radius, [1, 0, 0], segments),
    ...generateCircle(center, radius, [0, 1, 0], segments),
    ...generateCircle(center, radius, [0, 0, 1], segments),
  ];
}

/**
 * Generate a small handle sphere (fewer segments) for click-selection feedback.
 */
function generateHandleSphere(center: vec3, radius: number): number[] {
  return generateWireSphere(center, radius, 12);
}

/**
 * Generate a directional light arrow: line + arrowhead.
 */
function generateDirectionalArrow(position: vec3, direction: vec3, length = 3): number[] {
  const lines: number[] = [];
  const tip: vec3 = [
    position[0] + direction[0] * length,
    position[1] + direction[1] * length,
    position[2] + direction[2] * length,
  ];

  // Main line
  lines.push(...position, ...tip);

  // Arrowhead: two side lines
  const headLen = length * 0.25;
  let up: vec3 = [0, 1, 0];
  if (Math.abs(direction[1]) > 0.99) up = [0, 0, 1];
  const right = vec3.create();
  vec3.cross(right, direction as vec3, up);
  vec3.normalize(right, right);
  const upPerp = vec3.create();
  vec3.cross(upPerp, right, direction as vec3);
  vec3.normalize(upPerp, upPerp);

  const headBase: vec3 = [
    tip[0] - direction[0] * headLen,
    tip[1] - direction[1] * headLen,
    tip[2] - direction[2] * headLen,
  ];
  const headSize = headLen * 0.5;

  // 4 arrowhead lines
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const base: vec3 = [
      headBase[0] + right[0] * dx * headSize + upPerp[0] * dy * headSize,
      headBase[1] + right[1] * dx * headSize + upPerp[1] * dy * headSize,
      headBase[2] + right[2] * dx * headSize + upPerp[2] * dy * headSize,
    ];
    lines.push(...tip, ...base);
  }

  return lines;
}

/**
 * Generate a wireframe spot cone.
 * @param includeHandle If true, appends a small handle sphere at the cone tip.
 */
function generateSpotCone(position: vec3, direction: vec3, range: number, outerAngle: number, segments = 16, includeHandle = true): number[] {
  const lines: number[] = [];

  // Tip of cone = position
  // Base center = position + direction * range
  const baseCenter: vec3 = [
    position[0] + direction[0] * range,
    position[1] + direction[1] * range,
    position[2] + direction[2] * range,
  ];
  const baseRadius = Math.tan(outerAngle) * range;

  // Base circle
  lines.push(...generateCircle(baseCenter, baseRadius, direction as vec3, segments));

  // Side lines from tip to base circle (4 lines)
  let up: vec3 = [0, 1, 0];
  if (Math.abs(direction[1]) > 0.99) up = [0, 0, 1];
  const right = vec3.create();
  vec3.cross(right, direction as vec3, up);
  vec3.normalize(right, right);
  const upPerp = vec3.create();
  vec3.cross(upPerp, right, direction as vec3);
  vec3.normalize(upPerp, upPerp);

  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const basePoint: vec3 = [
      baseCenter[0] + right[0] * dx * baseRadius + upPerp[0] * dy * baseRadius,
      baseCenter[1] + right[1] * dx * baseRadius + upPerp[1] * dy * baseRadius,
      baseCenter[2] + right[2] * dx * baseRadius + upPerp[2] * dy * baseRadius,
    ];
    lines.push(...position, ...basePoint);
  }

  // Center axis line
  lines.push(...position, ...baseCenter);

  // Optional: small sphere at the cone tip (light position) for selection handle
  if (includeHandle) {
    lines.push(...generateHandleSphere(position, HANDLE_SPHERE_RADIUS));
  }

  return lines;
}

/** Desired screen-space size of handle spheres in pixels */
const HANDLE_SCREEN_SIZE = 60;
/** Default FOV for scale computation */
const DEFAULT_FOV = Math.PI / 4;

/** A single draw item: geometry buffer + vertex count + color + model matrix offset */
interface DrawItem {
  buffer: UnifiedGPUBuffer;
  vertexCount: number;
  color: [number, number, number, number];
  /** World position of the light (for screen-space scale computation) */
  lightPosition: vec3;
  /** Whether this item should use screen-space scaling */
  screenSpaceScale: boolean;
}

export class LightVisualizerGPU {
  private ctx: GPUContext;
  private linePipeline: RenderPipelineWrapper;
  private bindGroupLayout: GPUBindGroupLayout;

  // Pool of uniform buffers + bind groups (one per draw call)
  private uniformBuffers: UnifiedGPUBuffer[] = [];
  private bindGroups: GPUBindGroup[] = [];

  // Per-frame draw items (rebuilt each frame from ECS query)
  private drawItems: DrawItem[] = [];
  private _drawCount = 0;

  /** Whether light helpers are visible */
  enabled = true;

  /** Number of light helpers queued for rendering this frame */
  get drawCount(): number { return this._drawCount; }

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    this.bindGroupLayout = new BindGroupLayoutBuilder('light-viz-bind-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);

    // Pre-allocate pool
    for (let i = 0; i < MAX_HELPERS; i++) {
      const ub = UnifiedGPUBuffer.createUniform(ctx, {
        label: `light-viz-uniforms-${i}`,
        size: UNIFORM_SIZE,
      });
      const bg = new BindGroupBuilder(`light-viz-bg-${i}`)
        .buffer(0, ub)
        .build(ctx, this.bindGroupLayout);
      this.uniformBuffers.push(ub);
      this.bindGroups.push(bg);
    }

    const vertexLayout: VertexBufferLayoutDesc = {
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
    };

    this.linePipeline = RenderPipelineWrapper.create(ctx, {
      label: 'light-visualizer-line-pipeline',
      vertexShader: gizmoShader,
      fragmentShader: gizmoShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [vertexLayout],
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'line-list',
      cullMode: 'none',
      colorFormats: [ctx.format],
    });
  }

  /** Helper to add a draw item */
  private addDrawItem(label: string, lineData: number[], color: [number, number, number, number], lightPos: vec3, screenSpaceScale: boolean): void {
    if (lineData.length === 0 || this._drawCount >= MAX_HELPERS) return;
    const data = new Float32Array(lineData);
    const vertexCount = data.length / 3;
    const buf = UnifiedGPUBuffer.createVertex(this.ctx, { label, data });
    this.drawItems.push({ buffer: buf, vertexCount, color, lightPosition: lightPos, screenSpaceScale });
    this._drawCount++;
  }

  /**
   * Rebuild line geometry from ECS light entities.
   * Only renders helpers for the currently selected light entity.
   * Call once per frame before render().
   */
  update(world: World): void {
    // Destroy previous frame's buffers
    for (const item of this.drawItems) item.buffer.destroy();
    this.drawItems = [];
    this._drawCount = 0;

    if (!this.enabled) return;

    const entities = world.queryAny('light');
    for (const entity of entities) {
      if (this._drawCount >= MAX_HELPERS) break;

      const light = entity.getComponent<LightComponent>('light');
      if (!light || !light.enabled) continue;

      const transform = entity.getComponent<TransformComponent>('transform');
      const pos: vec3 = transform
        ? transform.worldPosition
        : [0, 0, 0];

      const color = HELPER_COLOR;
      const entityLabel = entity.name ?? entity.id;

      if (light.lightType === 'point') {
        // Handle sphere at origin (will be positioned via model matrix with screen-space scale)
        const handleData = generateHandleSphere([0, 0, 0], HANDLE_SPHERE_RADIUS);
        this.addDrawItem(`light-viz-${entityLabel}-handle`, handleData, color, pos, true);
      } else if (light.lightType === 'spot') {
        const dir = light.direction;
        const range = light.range ?? 10;
        const outerAngle = light.outerConeAngle ?? Math.PI / 4;
        // World-space cone geometry (lines from world-space position)
        const coneData = generateSpotCone(pos, dir, range, outerAngle, 16, false);
        this.addDrawItem(`light-viz-${entityLabel}-cone`, coneData, color, pos, false);
        // Screen-space handle sphere at origin (positioned via model matrix)
        const handleData = generateHandleSphere([0, 0, 0], HANDLE_SPHERE_RADIUS);
        this.addDrawItem(`light-viz-${entityLabel}-handle`, handleData, color, pos, true);
      }
    }
  }

  /**
   * Compute screen-space scale factor so handle spheres maintain constant pixel size.
   * Same algorithm as BaseGizmo.getScreenSpaceScale().
   */
  private computeScreenScale(lightPos: vec3, cameraPos: vec3, fov: number, canvasHeight: number): number {
    const distance = vec3.distance(cameraPos, lightPos);
    const worldUnitsPerPixel = (2 * distance * Math.tan(fov / 2)) / canvasHeight;
    return worldUnitsPerPixel * HANDLE_SCREEN_SIZE;
  }

  /**
   * Render light helper wireframes.
   * @param passEncoder Active render pass (backbuffer overlay, no depth)
   * @param vpMatrix View-projection matrix
   * @param cameraPosition Camera world position (for screen-space scaling)
   * @param canvasHeight Canvas height in pixels
   * @param fov Camera vertical FOV in radians (optional, defaults to π/4)
   */
  render(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: Float32Array,
    cameraPosition?: [number, number, number],
    canvasHeight?: number,
    fov?: number,
  ): void {
    if (!this.enabled || this._drawCount === 0) return;

    const camPos: vec3 = cameraPosition ?? [0, 0, 0];
    const height = canvasHeight ?? 600;
    const camFov = fov ?? DEFAULT_FOV;

    passEncoder.setPipeline(this.linePipeline.pipeline);

    for (let i = 0; i < this.drawItems.length; i++) {
      const item = this.drawItems[i];
      if (!item || item.vertexCount <= 0 || i >= this.uniformBuffers.length) continue;

      // Write uniforms: VP + model + color
      const uniformData = new Float32Array(UNIFORM_SIZE / 4);
      uniformData.set(vpMatrix, 0);

      if (item.screenSpaceScale) {
        // Screen-space scaled model matrix: translate to light position, then uniform scale
        const s = this.computeScreenScale(item.lightPosition, camPos, camFov, height);
        const p = item.lightPosition;
        // Column-major 4x4: translate + scale
        uniformData[16] = s;    uniformData[17] = 0;    uniformData[18] = 0;    uniformData[19] = 0;
        uniformData[20] = 0;    uniformData[21] = s;    uniformData[22] = 0;    uniformData[23] = 0;
        uniformData[24] = 0;    uniformData[25] = 0;    uniformData[26] = s;    uniformData[27] = 0;
        uniformData[28] = p[0]; uniformData[29] = p[1]; uniformData[30] = p[2]; uniformData[31] = 1;
      } else {
        // Identity model matrix (geometry already in world space)
        uniformData[16] = 1; uniformData[21] = 1; uniformData[26] = 1; uniformData[31] = 1;
      }

      uniformData.set(item.color, 32);
      this.uniformBuffers[i].write(this.ctx, uniformData);

      passEncoder.setBindGroup(0, this.bindGroups[i]);
      passEncoder.setVertexBuffer(0, item.buffer.buffer);
      passEncoder.draw(item.vertexCount);
    }
  }

  destroy(): void {
    for (const ub of this.uniformBuffers) ub.destroy();
    for (const item of this.drawItems) item.buffer.destroy();
    this.uniformBuffers = [];
    this.bindGroups = [];
    this.drawItems = [];
  }
}