/**
 * CameraFrustumRendererGPU - Renders a wireframe camera frustum visualization
 * 
 * When in debug camera mode, this renders the scene camera as a visible
 * wireframe: a small triangle representing the camera body, a short line
 * indicating the look direction, and the frustum near/far planes.
 * 
 * Also visualises CSM cascade split planes (coloured slices inside the frustum)
 * and per-cascade light ortho bounding boxes when CSM data is provided.
 * 
 * Reuses the gizmo.wgsl shader (unlit colored geometry).
 */

import { mat4, vec3 } from 'gl-matrix';
import { GPUContext } from '../GPUContext';
import { UnifiedGPUBuffer } from '../GPUBuffer';
import { RenderPipelineWrapper, type VertexBufferLayoutDesc } from '../GPURenderPipeline';
import { BindGroupLayoutBuilder, BindGroupBuilder } from '../GPUBindGroup';
import {
  calculateCascadeSplits,
  calculateCascadeLightMatrix,
  getLightOrthoBoxCorners,
  getFrustumCornersWorldSpace,
  MAX_CASCADES,
  type CascadeLightResult,
} from './shared/CSMUtils';

import gizmoShader from '../shaders/gizmo.wgsl?raw';

/**
 * Uniform buffer layout (must match gizmo.wgsl):
 * - viewProjection: mat4x4f (64 bytes)
 * - model: mat4x4f (64 bytes)
 * - color: vec4f (16 bytes)
 * Total: 144 bytes
 */
const UNIFORM_SIZE = 144;

/** Camera frustum wireframe color */
const FRUSTUM_COLOR: [number, number, number, number] = [0.1, 0.1, 0.1, 1.0];

/** Camera body color (brighter yellow) */
const BODY_COLOR: [number, number, number, number] = [1.0, 0.85, 0.2, 1.0];

/** Per-cascade colours (red, green, blue, magenta) */
const CASCADE_COLORS: [number, number, number, number][] = [
  [1.0, 0.3, 0.3, 0.7],   // cascade 0 – red
  [0.3, 1.0, 0.3, 0.7],   // cascade 1 – green
  [0.3, 0.5, 1.0, 0.7],   // cascade 2 – blue
  [1.0, 0.3, 1.0, 0.7],   // cascade 3 – magenta
];

/** CSM information passed to the frustum renderer each frame */
export interface CSMDebugInfo {
  lightDirection: [number, number, number];
  cascadeCount: number;
  cascadeSplitLambda: number;
  shadowRadius: number;
}

/**
 * Renders a camera frustum wireframe visualization with optional CSM overlays
 */
export class CameraFrustumRendererGPU {
  private ctx: GPUContext;

  // Pipelines
  private linePipeline: RenderPipelineWrapper;
  private trianglePipeline: RenderPipelineWrapper;
  private bindGroupLayout: GPUBindGroupLayout;

  // Pool of uniform buffers / bind groups – one per draw call colour
  // Index 0 = frustum lines, 1 = camera body, 2..5 = cascade 0-3 split, 6..9 = cascade 0-3 ortho
  private uniformBuffers: UnifiedGPUBuffer[] = [];
  private bindGroups: GPUBindGroup[] = [];

  // Geometry buffers (rebuilt when camera changes)
  private frustumLinesBuffer: UnifiedGPUBuffer | null = null;
  private frustumLinesVertexCount = 0;

  private cameraBodyBuffer: UnifiedGPUBuffer | null = null;
  private cameraBodyVertexCount = 0;

  // CSM cascade split plane lines (per cascade)
  private cascadeSplitBuffers: (UnifiedGPUBuffer | null)[] = [];
  private cascadeSplitVertexCounts: number[] = [];

  // CSM light ortho box lines (per cascade)
  private cascadeOrthoBuffers: (UnifiedGPUBuffer | null)[] = [];
  private cascadeOrthoVertexCounts: number[] = [];

  private static POOL_SIZE = 2 + MAX_CASCADES * 2; // frustum + body + splits + orthos

  constructor(ctx: GPUContext) {
    this.ctx = ctx;

    // Create bind group layout (same as gizmo)
    this.bindGroupLayout = new BindGroupLayoutBuilder('camera-frustum-bind-layout')
      .uniformBuffer(0, 'all')
      .build(ctx);

    // Allocate pool of uniform buffers + bind groups
    for (let i = 0; i < CameraFrustumRendererGPU.POOL_SIZE; i++) {
      const ub = UnifiedGPUBuffer.createUniform(ctx, {
        label: `camera-frustum-uniforms-${i}`,
        size: UNIFORM_SIZE,
      });
      const bg = new BindGroupBuilder(`camera-frustum-bg-${i}`)
        .buffer(0, ub)
        .build(ctx, this.bindGroupLayout);
      this.uniformBuffers.push(ub);
      this.bindGroups.push(bg);
    }

    // Vertex layout: position only (vec3f, 12 bytes)
    const vertexLayout: VertexBufferLayoutDesc = {
      arrayStride: 12,
      stepMode: 'vertex',
      attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
    };

    // Line pipeline (for frustum wireframe + cascade lines)
    this.linePipeline = RenderPipelineWrapper.create(ctx, {
      label: 'camera-frustum-line-pipeline',
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

    // Triangle pipeline (for camera body)
    this.trianglePipeline = RenderPipelineWrapper.create(ctx, {
      label: 'camera-frustum-triangle-pipeline',
      vertexShader: gizmoShader,
      fragmentShader: gizmoShader,
      vertexEntryPoint: 'vs_main',
      fragmentEntryPoint: 'fs_main',
      vertexBuffers: [vertexLayout],
      bindGroupLayouts: [this.bindGroupLayout],
      topology: 'triangle-list',
      cullMode: 'none',
      colorFormats: [ctx.format],
    });
  }

  /**
   * Build frustum geometry from camera parameters.
   * Also builds CSM cascade split planes and light ortho boxes when csmInfo is provided.
   */
  updateFrustum(
    cameraPosition: [number, number, number],
    cameraTarget: [number, number, number],
    fovDegrees: number,
    aspectRatio: number,
    near: number,
    far: number,
    csmInfo?: CSMDebugInfo
  ): void {
    const cappedFarPlane = csmInfo?.shadowRadius ? Math.min(far, csmInfo?.shadowRadius) : far;
    // Compute camera basis vectors
    const pos = vec3.fromValues(cameraPosition[0], cameraPosition[1], cameraPosition[2]);
    const target = vec3.fromValues(cameraTarget[0], cameraTarget[1], cameraTarget[2]);

    const forward = vec3.create();
    vec3.subtract(forward, target, pos);
    vec3.normalize(forward, forward);

    const worldUp = vec3.fromValues(0, 1, 0);
    const right = vec3.create();
    vec3.cross(right, forward, worldUp);
    vec3.normalize(right, right);

    const up = vec3.create();
    vec3.cross(up, right, forward);
    vec3.normalize(up, up);

    // Compute frustum corners
    const fovRad = (fovDegrees * Math.PI) / 180;
    const visFar = Math.min(cappedFarPlane, 50);
    const visNear = near;

    const nearH = Math.tan(fovRad / 2) * visNear;
    const nearW = nearH * aspectRatio;
    const farH = Math.tan(fovRad / 2) * visFar;
    const farW = farH * aspectRatio;

    // Near plane corners
    const nc = vec3.create();
    vec3.scaleAndAdd(nc, pos, forward, visNear);
    const ntl = vec3.create(); vec3.scaleAndAdd(ntl, nc, up, nearH); vec3.scaleAndAdd(ntl, ntl, right, -nearW);
    const ntr = vec3.create(); vec3.scaleAndAdd(ntr, nc, up, nearH); vec3.scaleAndAdd(ntr, ntr, right, nearW);
    const nbl = vec3.create(); vec3.scaleAndAdd(nbl, nc, up, -nearH); vec3.scaleAndAdd(nbl, nbl, right, -nearW);
    const nbr = vec3.create(); vec3.scaleAndAdd(nbr, nc, up, -nearH); vec3.scaleAndAdd(nbr, nbr, right, nearW);

    // Far plane corners
    const fc = vec3.create();
    vec3.scaleAndAdd(fc, pos, forward, visFar);
    const ftl = vec3.create(); vec3.scaleAndAdd(ftl, fc, up, farH); vec3.scaleAndAdd(ftl, ftl, right, -farW);
    const ftr = vec3.create(); vec3.scaleAndAdd(ftr, fc, up, farH); vec3.scaleAndAdd(ftr, ftr, right, farW);
    const fbl = vec3.create(); vec3.scaleAndAdd(fbl, fc, up, -farH); vec3.scaleAndAdd(fbl, fbl, right, -farW);
    const fbr = vec3.create(); vec3.scaleAndAdd(fbr, fc, up, -farH); vec3.scaleAndAdd(fbr, fbr, right, farW);

    // -- Build frustum line geometry --
    const lines: number[] = [];
    lines.push(...ntl, ...ntr, ...ntr, ...nbr, ...nbr, ...nbl, ...nbl, ...ntl);
    lines.push(...ftl, ...ftr, ...ftr, ...fbr, ...fbr, ...fbl, ...fbl, ...ftl);
    lines.push(...ntl, ...ftl, ...ntr, ...ftr, ...nbl, ...fbl, ...nbr, ...fbr);

    // Direction indicator line
    const dirEnd = vec3.create();
    vec3.scaleAndAdd(dirEnd, pos, forward, visFar * 0.15);
    lines.push(pos[0], pos[1], pos[2], dirEnd[0], dirEnd[1], dirEnd[2]);

    this.frustumLinesBuffer?.destroy();
    const lineData = new Float32Array(lines);
    this.frustumLinesVertexCount = lineData.length / 3;
    this.frustumLinesBuffer = UnifiedGPUBuffer.createVertex(this.ctx, { label: 'camera-frustum-lines', data: lineData });

    // -- Camera body --
    const bodySize = visFar * 0.04;
    const bodyTip = vec3.create(); vec3.scaleAndAdd(bodyTip, pos, forward, bodySize * 2);
    const bodyLeft = vec3.create(); vec3.scaleAndAdd(bodyLeft, pos, right, -bodySize); vec3.scaleAndAdd(bodyLeft, bodyLeft, up, -bodySize * 0.5);
    const bodyRight = vec3.create(); vec3.scaleAndAdd(bodyRight, pos, right, bodySize); vec3.scaleAndAdd(bodyRight, bodyRight, up, -bodySize * 0.5);
    const bodyTop = vec3.create(); vec3.scaleAndAdd(bodyTop, pos, up, bodySize);
    const bodyVerts = [
      ...bodyTip, ...bodyLeft, ...bodyRight,
      ...bodyTip, ...bodyTop, ...bodyLeft,
      ...bodyTip, ...bodyRight, ...bodyTop,
      ...bodyLeft, ...bodyTop, ...bodyRight,
    ];
    this.cameraBodyBuffer?.destroy();
    const bodyData = new Float32Array(bodyVerts);
    this.cameraBodyVertexCount = bodyData.length / 3;
    this.cameraBodyBuffer = UnifiedGPUBuffer.createVertex(this.ctx, { label: 'camera-body-triangles', data: bodyData });

    // -- CSM cascade visualisation --
    this.destroyCascadeBuffers();

    if (csmInfo && csmInfo.cascadeCount > 0) {
      // Build a camera view matrix from position/target for CSMUtils
      const cameraView = mat4.create();
      mat4.lookAt(cameraView, pos, target, worldUp);

      // Build a perspective projection matching the scene camera
      const cameraProj = mat4.create();
      mat4.perspective(cameraProj, fovRad, aspectRatio, near, cappedFarPlane);

      const splits = calculateCascadeSplits(
        near, cappedFarPlane,
        csmInfo.cascadeCount,
        csmInfo.cascadeSplitLambda
      );

      const lightDir = vec3.fromValues(
        csmInfo.lightDirection[0],
        csmInfo.lightDirection[1],
        csmInfo.lightDirection[2],
      );

      let prevSplit = near;
      for (let i = 0; i < csmInfo.cascadeCount; i++) {
        const splitEnd = splits[i];

        // --- Cascade split plane (rectangle at splitEnd distance inside frustum) ---
        const splitH = Math.tan(fovRad / 2) * splitEnd;
        const splitW = splitH * aspectRatio;
        const sc = vec3.create(); vec3.scaleAndAdd(sc, pos, forward, splitEnd);
        const stl = vec3.create(); vec3.scaleAndAdd(stl, sc, up, splitH); vec3.scaleAndAdd(stl, stl, right, -splitW);
        const str = vec3.create(); vec3.scaleAndAdd(str, sc, up, splitH); vec3.scaleAndAdd(str, str, right, splitW);
        const sbl = vec3.create(); vec3.scaleAndAdd(sbl, sc, up, -splitH); vec3.scaleAndAdd(sbl, sbl, right, -splitW);
        const sbr = vec3.create(); vec3.scaleAndAdd(sbr, sc, up, -splitH); vec3.scaleAndAdd(sbr, sbr, right, splitW);

        const splitLines: number[] = [];
        // Rectangle edges
        splitLines.push(...stl, ...str, ...str, ...sbr, ...sbr, ...sbl, ...sbl, ...stl);
        // Cross diagonals so the split plane is clearly visible
        splitLines.push(...stl, ...sbr, ...str, ...sbl);

        const sd = new Float32Array(splitLines);
        this.cascadeSplitVertexCounts[i] = sd.length / 3;
        this.cascadeSplitBuffers[i] = UnifiedGPUBuffer.createVertex(this.ctx, { label: `csm-split-${i}`, data: sd });

        // --- Light ortho bounding box ---
        const cascadeResult: CascadeLightResult = calculateCascadeLightMatrix(
          lightDir, cameraView, cameraProj,
          prevSplit, splitEnd,
          csmInfo.shadowRadius
        );

        const boxCorners = getLightOrthoBoxCorners(
          cascadeResult.lightView,
          cascadeResult.minX, cascadeResult.maxX,
          cascadeResult.minY, cascadeResult.maxY,
          cascadeResult.minZ, cascadeResult.maxZ,
        );

        // 12 edges of the box (indices follow standard cube winding)
        // corners order from getLightOrthoBoxCorners:
        //  0=(minX,minY,minZ), 1=(minX,minY,maxZ), 2=(minX,maxY,minZ), 3=(minX,maxY,maxZ),
        //  4=(maxX,minY,minZ), 5=(maxX,minY,maxZ), 6=(maxX,maxY,minZ), 7=(maxX,maxY,maxZ)
        const edges = [
          [0,1],[2,3],[4,5],[6,7],  // Z edges
          [0,2],[1,3],[4,6],[5,7],  // Y edges
          [0,4],[1,5],[2,6],[3,7],  // X edges
        ];
        const orthoLines: number[] = [];
        for (const [a, b] of edges) {
          orthoLines.push(boxCorners[a][0], boxCorners[a][1], boxCorners[a][2]);
          orthoLines.push(boxCorners[b][0], boxCorners[b][1], boxCorners[b][2]);
        }

        const od = new Float32Array(orthoLines);
        this.cascadeOrthoVertexCounts[i] = od.length / 3;
        this.cascadeOrthoBuffers[i] = UnifiedGPUBuffer.createVertex(this.ctx, { label: `csm-ortho-${i}`, data: od });

        prevSplit = splitEnd;
      }
    }
  }

  // ==================== Helpers ====================

  private buildUniformData(
    vpMatrix: Float32Array,
    color: [number, number, number, number]
  ): Float32Array {
    const data = new Float32Array(UNIFORM_SIZE / 4);
    data.set(vpMatrix, 0);
    // Identity model matrix (offset 16)
    data[16] = 1; data[21] = 1; data[26] = 1; data[31] = 1;
    data.set(color, 32);
    return data;
  }

  private destroyCascadeBuffers(): void {
    for (const b of this.cascadeSplitBuffers) b?.destroy();
    for (const b of this.cascadeOrthoBuffers) b?.destroy();
    this.cascadeSplitBuffers = [];
    this.cascadeSplitVertexCounts = [];
    this.cascadeOrthoBuffers = [];
    this.cascadeOrthoVertexCounts = [];
  }

  // ==================== Render ====================

  /**
   * Render the camera frustum visualization (+ CSM overlays)
   * @param passEncoder Active render pass encoder (backbuffer overlay)
   * @param vpMatrix The debug/view camera's view-projection matrix
   */
  render(passEncoder: GPURenderPassEncoder, vpMatrix: Float32Array): void {
    let poolIdx = 0;

    // Helper to write + draw a line buffer using the next pool slot
    const drawLines = (buf: UnifiedGPUBuffer | null, count: number, color: [number, number, number, number]) => {
      if (!buf || count <= 0 || poolIdx >= this.uniformBuffers.length) return;
      this.uniformBuffers[poolIdx].write(this.ctx, this.buildUniformData(vpMatrix, color));
      passEncoder.setPipeline(this.linePipeline.pipeline);
      passEncoder.setBindGroup(0, this.bindGroups[poolIdx]);
      passEncoder.setVertexBuffer(0, buf.buffer);
      passEncoder.draw(count);
      poolIdx++;
    };

    const drawTriangles = (buf: UnifiedGPUBuffer | null, count: number, color: [number, number, number, number]) => {
      if (!buf || count <= 0 || poolIdx >= this.uniformBuffers.length) return;
      this.uniformBuffers[poolIdx].write(this.ctx, this.buildUniformData(vpMatrix, color));
      passEncoder.setPipeline(this.trianglePipeline.pipeline);
      passEncoder.setBindGroup(0, this.bindGroups[poolIdx]);
      passEncoder.setVertexBuffer(0, buf.buffer);
      passEncoder.draw(count);
      poolIdx++;
    };

    // 1. Frustum wireframe
    drawLines(this.frustumLinesBuffer, this.frustumLinesVertexCount, FRUSTUM_COLOR);

    // 2. Camera body
    drawTriangles(this.cameraBodyBuffer, this.cameraBodyVertexCount, BODY_COLOR);

    // 3. CSM cascade split planes
    for (let i = 0; i < this.cascadeSplitBuffers.length; i++) {
      const color = CASCADE_COLORS[i % CASCADE_COLORS.length];
      drawLines(this.cascadeSplitBuffers[i], this.cascadeSplitVertexCounts[i], color);
    }

    // 4. CSM light ortho boxes
    for (let i = 0; i < this.cascadeOrthoBuffers.length; i++) {
      // Use same cascade colour but slightly dimmer for ortho boxes
      const base = CASCADE_COLORS[i % CASCADE_COLORS.length];
      const dimmed: [number, number, number, number] = [base[0] * 0.6, base[1] * 0.6, base[2] * 0.6, 0.5];
      drawLines(this.cascadeOrthoBuffers[i], this.cascadeOrthoVertexCounts[i], dimmed);
    }
  }

  /**
   * Clean up GPU resources
   */
  destroy(): void {
    for (const ub of this.uniformBuffers) ub.destroy();
    this.uniformBuffers = [];
    this.bindGroups = [];
    this.frustumLinesBuffer?.destroy();
    this.cameraBodyBuffer?.destroy();
    this.destroyCascadeBuffers();
  }
}