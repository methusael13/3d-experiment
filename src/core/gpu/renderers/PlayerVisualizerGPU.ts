/**
 * PlayerVisualizerGPU — Renders wireframe helper for player entities.
 *
 * Visualisation: wireframe sphere (player head) + arrow pointing in the
 * camera look direction (derived from yaw/pitch).
 *
 * Reuses gizmo.wgsl (unlit colored geometry, line-list topology).
 * Called from Viewport overlay pass after the main pipeline.
 * Hidden during FPS play mode (you ARE the player).
 */

import { vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, type VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import type { World } from '../../ecs/World';
import { PlayerComponent } from '../../ecs/components/PlayerComponent';
import { TransformComponent } from '../../ecs/components/TransformComponent';

import gizmoShader from '../shaders/gizmo.wgsl?raw';

/** Uniform size: VP(64) + model(64) + color(16) = 144 bytes — matches gizmo.wgsl */
const UNIFORM_SIZE = 144;

/** Max player helpers we pre-allocate pool slots for */
const MAX_HELPERS = 4;

/** Dark color for player body sphere (high contrast against sky/terrain) */
const PLAYER_BODY_COLOR: [number, number, number, number] = [0.05, 0.05, 0.05, 1.0];

/** Slightly lighter dark for the look-direction arrow */
const PLAYER_ARROW_COLOR: [number, number, number, number] = [0.1, 0.1, 0.1, 1.0];

/** Desired screen-space size of player sphere in pixels */
const HANDLE_SCREEN_SIZE = 70;

/** Default FOV for scale computation */
const DEFAULT_FOV = Math.PI / 4;

/** Sphere radius in local space (before screen-space scaling) */
const SPHERE_RADIUS = 0.35;

/** Arrow length in local space (before screen-space scaling) */
const ARROW_LENGTH = 1.2;

// ==================== Geometry generators ====================

/**
 * Generate wireframe circle vertices (line-list) in a plane defined by a normal.
 */
function generateCircle(center: vec3, radius: number, normal: vec3, segments: number): number[] {
  const lines: number[] = [];

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
 * Generate a wireframe sphere (3 orthogonal circles) centered at origin.
 */
function generateWireSphere(radius: number, segments = 16): number[] {
  const origin: vec3 = [0, 0, 0];
  return [
    ...generateCircle(origin, radius, [1, 0, 0], segments),
    ...generateCircle(origin, radius, [0, 1, 0], segments),
    ...generateCircle(origin, radius, [0, 0, 1], segments),
  ];
}

/**
 * Generate a look-direction arrow in local space.
 * The arrow points along +Z (yaw=0, pitch=0 default forward).
 * The model matrix will rotate it to match yaw/pitch.
 */
function generateArrow(length: number): number[] {
  const lines: number[] = [];
  const tip: vec3 = [0, 0, length];

  // Main line from origin to tip
  lines.push(0, 0, 0, ...tip);

  // Arrowhead: 4 lines from tip backward
  const headLen = length * 0.25;
  const headSize = headLen * 0.4;

  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
    const base: vec3 = [
      dx * headSize,
      dy * headSize,
      length - headLen,
    ];
    lines.push(...tip, ...base);
  }

  return lines;
}

// ==================== Pre-generated geometry ====================

const SPHERE_DATA = new Float32Array(generateWireSphere(SPHERE_RADIUS));
const ARROW_DATA = new Float32Array(generateArrow(ARROW_LENGTH));

// ==================== Types ====================

interface DrawItem {
  buffer: UnifiedGPUBuffer;
  vertexCount: number;
  color: [number, number, number, number];
  /** World position of the player */
  worldPosition: vec3;
  /** Yaw radians for model rotation */
  yaw: number;
  /** Pitch radians for model rotation */
  pitch: number;
  /** Whether to apply yaw/pitch rotation (arrow) or just translate+scale (sphere) */
  applyRotation: boolean;
}

// ==================== PlayerVisualizerGPU ====================

export class PlayerVisualizerGPU {
  private ctx: GPUContext;
  private linePipeline: RenderPipelineWrapper;
  private bindGroupLayout: GPUBindGroupLayout;

  // Pool of uniform buffers + bind groups
  private uniformBuffers: UnifiedGPUBuffer[] = [];
  private bindGroups: GPUBindGroup[] = [];

  // Per-frame draw items
  private drawItems: DrawItem[] = [];
  private _drawCount = 0;

  /** Whether player helpers are visible */
  enabled = true;

  /** Number of draw items queued this frame */
  get drawCount(): number { return this._drawCount; }

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    this.bindGroupLayout = new BindGroupLayoutBuilder('player-viz-bind-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);

    // Pre-allocate pool
    for (let i = 0; i < MAX_HELPERS; i++) {
      const ub = UnifiedGPUBuffer.createUniform(ctx, {
        label: `player-viz-uniforms-${i}`,
        size: UNIFORM_SIZE,
      });
      const bg = new BindGroupBuilder(`player-viz-bg-${i}`)
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
      label: 'player-visualizer-line-pipeline',
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

  /**
   * Rebuild draw items from ECS player entities.
   * Call once per frame before render().
   */
  update(world: World): void {
    // Destroy previous frame's vertex buffers
    for (const item of this.drawItems) item.buffer.destroy();
    this.drawItems = [];
    this._drawCount = 0;

    if (!this.enabled) return;

    const entities = world.queryAny('player');
    for (const entity of entities) {
      if (this._drawCount >= MAX_HELPERS) break;

      const player = entity.getComponent<PlayerComponent>('player');
      if (!player) continue;

      const transform = entity.getComponent<TransformComponent>('transform');
      const pos: vec3 = transform ? transform.worldPosition : [0, 0, 0];

      // 1. Sphere at player head
      const sphereBuf = UnifiedGPUBuffer.createVertex(this.ctx, {
        label: `player-viz-sphere-${entity.name ?? entity.id}`,
        data: SPHERE_DATA,
      });
      this.drawItems.push({
        buffer: sphereBuf,
        vertexCount: SPHERE_DATA.length / 3,
        color: PLAYER_BODY_COLOR,
        worldPosition: pos,
        yaw: 0,
        pitch: 0,
        applyRotation: false,
      });
      this._drawCount++;

      if (this._drawCount >= MAX_HELPERS) break;

      // 2. Arrow showing look direction
      const arrowBuf = UnifiedGPUBuffer.createVertex(this.ctx, {
        label: `player-viz-arrow-${entity.name ?? entity.id}`,
        data: ARROW_DATA,
      });
      this.drawItems.push({
        buffer: arrowBuf,
        vertexCount: ARROW_DATA.length / 3,
        color: PLAYER_ARROW_COLOR,
        worldPosition: pos,
        yaw: player.yaw,
        pitch: player.pitch,
        applyRotation: true,
      });
      this._drawCount++;
    }
  }

  /**
   * Compute screen-space scale factor so the player helper maintains constant pixel size.
   */
  private computeScreenScale(worldPos: vec3, cameraPos: vec3, fov: number, canvasHeight: number): number {
    const distance = vec3.distance(cameraPos, worldPos);
    const worldUnitsPerPixel = (2 * distance * Math.tan(fov / 2)) / canvasHeight;
    return worldUnitsPerPixel * HANDLE_SCREEN_SIZE;
  }

  /**
   * Render player helper wireframes.
   * @param passEncoder Active render pass (backbuffer overlay, no depth)
   * @param vpMatrix View-projection matrix
   * @param cameraPosition Camera world position (for screen-space scaling)
   * @param canvasHeight Canvas height in pixels
   * @param fov Camera vertical FOV in radians (optional)
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

      const uniformData = new Float32Array(UNIFORM_SIZE / 4);
      uniformData.set(vpMatrix, 0);

      const s = this.computeScreenScale(item.worldPosition, camPos, camFov, height);
      const p = item.worldPosition;

      if (item.applyRotation) {
        // Build model matrix: translate to position, then rotate by yaw (Y) and pitch (X), then scale
        // Column-major 4x4
        const cy = Math.cos(item.yaw);
        const sy = Math.sin(item.yaw);
        const cp = Math.cos(item.pitch);
        const sp = Math.sin(item.pitch);

        // Rotation = Ry(yaw) * Rx(pitch)
        // Ry = [ cy 0 sy 0; 0 1 0 0; -sy 0 cy 0; 0 0 0 1]
        // Rx = [ 1 0 0 0; 0 cp -sp 0; 0 sp cp 0; 0 0 0 1]
        // Combined (column-major):
        const m00 = cy * s;
        const m01 = 0;
        const m02 = -sy * s;
        const m10 = sy * sp * s;
        const m11 = cp * s;
        const m12 = cy * sp * s;
        const m20 = sy * cp * s;
        const m21 = -sp * s;
        const m22 = cy * cp * s;

        // Column-major layout: columns are [m00,m10,m20,0], [m01,m11,m21,0], [m02,m12,m22,0], [px,py,pz,1]
        uniformData[16] = m00;  uniformData[17] = m10;  uniformData[18] = m20;  uniformData[19] = 0;
        uniformData[20] = m01;  uniformData[21] = m11;  uniformData[22] = m21;  uniformData[23] = 0;
        uniformData[24] = m02;  uniformData[25] = m12;  uniformData[26] = m22;  uniformData[27] = 0;
        uniformData[28] = p[0]; uniformData[29] = p[1]; uniformData[30] = p[2]; uniformData[31] = 1;
      } else {
        // Translation + uniform scale (no rotation)
        uniformData[16] = s;    uniformData[17] = 0;    uniformData[18] = 0;    uniformData[19] = 0;
        uniformData[20] = 0;    uniformData[21] = s;    uniformData[22] = 0;    uniformData[23] = 0;
        uniformData[24] = 0;    uniformData[25] = 0;    uniformData[26] = s;    uniformData[27] = 0;
        uniformData[28] = p[0]; uniformData[29] = p[1]; uniformData[30] = p[2]; uniformData[31] = 1;
      }

      // Color at offset 32
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