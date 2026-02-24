/**
 * BillboardBaker - Client-side billboard atlas generator using WebGPU
 * 
 * Renders a 3D model from multiple angles using a dedicated WebGPU pipeline,
 * captures the results into a texture atlas, and exports as PNG.
 * 
 * Uses the existing ObjectRendererGPU pipeline for full PBR rendering:
 * textures, normal maps, metallic-roughness — everything the main viewport uses.
 * 
 * Output: N-view horizontal strip atlas (albedo+alpha RGBA PNG)
 *   - Orthographic projection sized to model AABB
 *   - Alpha channel from model transparency
 */

import { mat4, vec3 } from 'gl-matrix';
import { loadGLB, type GLBModel } from '../../loaders';
import { computeBoundsFromGLB } from '../sceneGraph';
import type { GPUContext } from '../gpu/GPUContext';
import { UnifiedGPUTexture } from '../gpu/GPUTexture';
import { ObjectRendererGPU, type ObjectRenderParams, type GPUMaterial, type GPUMaterialTextures } from '../gpu/renderers/ObjectRendererGPU';
import { SceneEnvironment } from '../gpu/renderers/shared/SceneEnvironment';

// ==================== Types ====================

export interface BillboardBakeOptions {
  /** Number of viewing angles (default: 8) */
  viewCount?: number;
  /** Resolution per view in pixels (default: 1024) */
  resolution?: number;
  /** Background color [R, G, B, A] — default transparent black */
  backgroundColor?: [number, number, number, number];
}

export interface BillboardBakeResult {
  /** Atlas image as PNG Blob */
  albedoAtlas: Blob;
  /** Atlas dimensions */
  atlasWidth: number;
  atlasHeight: number;
  /** Number of views baked */
  viewCount: number;
  /** Resolution per view */
  resolution: number;
}

/** Internal resources for a bake session */
interface BakeSession {
  renderer: ObjectRendererGPU;
  sceneEnv: SceneEnvironment;
  textures: UnifiedGPUTexture[];
  meshIds: number[];
  colorTexture: GPUTexture;
  depthTexture: GPUTexture;
  center: [number, number, number];
  maxExtent: number;
}

// ==================== BillboardBaker ====================

export class BillboardBaker {
  
  /**
   * Bake a billboard atlas from a pre-loaded GLBModel using WebGPU.
   */
  static async bakeWithGPU(ctx: GPUContext, model: GLBModel, options: BillboardBakeOptions = {}): Promise<BillboardBakeResult> {
    const viewCount = options.viewCount ?? 8;
    const resolution = options.resolution ?? 1024;
    const bgColor = options.backgroundColor ?? [0, 0, 0, 0];
    
    const session = await createBakeSession(ctx, model, resolution);
    
    try {
      const atlasCanvas = createAtlasCanvas(resolution, viewCount, bgColor);
      
      for (let i = 0; i < viewCount; i++) {
        const angle = (i / viewCount) * Math.PI * 2;
        const imageData = await renderView(ctx, session, angle, resolution, bgColor);
        blitViewToAtlas(atlasCanvas, imageData, i, resolution);
      }
      
      const blob = await canvasToBlob(atlasCanvas.canvas);
      return { albedoAtlas: blob, atlasWidth: resolution * viewCount, atlasHeight: resolution, viewCount, resolution };
    } finally {
      destroyBakeSession(session);
    }
  }
  
  /**
   * Bake from a pre-loaded GLBModel. Uses WebGPU if gpuContext provided, else Canvas 2D fallback.
   */
  static async bakeFromModel(model: GLBModel, options: BillboardBakeOptions = {}, gpuContext?: GPUContext): Promise<BillboardBakeResult> {
    if (gpuContext) {
      return BillboardBaker.bakeWithGPU(gpuContext, model, options);
    }
    return bakeCanvas2D(model, options);
  }
  
  /**
   * Bake from a model URL (convenience wrapper).
   */
  static async bake(modelUrl: string, options: BillboardBakeOptions = {}, gpuContext?: GPUContext): Promise<BillboardBakeResult> {
    const model = await loadGLB(modelUrl);
    return BillboardBaker.bakeFromModel(model, options, gpuContext);
  }
}

// ==================== Session Management ====================

/**
 * Create an isolated bake session with its own renderer, textures, and offscreen targets.
 */
async function createBakeSession(ctx: GPUContext, model: GLBModel, resolution: number): Promise<BakeSession> {
  const bounds = computeBoundsFromGLB(model);
  if (!bounds) throw new Error('Model has no geometry — cannot generate billboard');
  
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const maxExtent = Math.max(
    (bounds.max[0] - bounds.min[0]) / 2,
    (bounds.max[1] - bounds.min[1]) / 2,
    (bounds.max[2] - bounds.min[2]) / 2,
  );
  
  const renderer = new ObjectRendererGPU(ctx);
  const sceneEnv = new SceneEnvironment(ctx);
  
  // Upload textures
  const { textures, textureMap } = await uploadModelTextures(ctx, model);
  
  // Register meshes
  const meshIds = registerModelMeshes(renderer, model, textureMap);
  
  // Create offscreen render targets
  const colorTexture = ctx.device.createTexture({
    label: 'billboard-bake-color',
    size: { width: resolution, height: resolution },
    format: 'rgba16float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  
  const depthTexture = ctx.device.createTexture({
    label: 'billboard-bake-depth',
    size: { width: resolution, height: resolution },
    format: 'depth24plus',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  
  return { renderer, sceneEnv, textures, meshIds, colorTexture, depthTexture, center, maxExtent };
}

/**
 * Destroy all resources from a bake session.
 */
function destroyBakeSession(session: BakeSession): void {
  session.colorTexture.destroy();
  session.depthTexture.destroy();
  for (const tex of session.textures) tex.destroy();
  session.renderer.destroy();
}

// ==================== GPU Texture Upload ====================

async function uploadModelTextures(ctx: GPUContext, model: GLBModel): Promise<{
  textures: UnifiedGPUTexture[];
  textureMap: Map<number, UnifiedGPUTexture>;
}> {
  const textures: UnifiedGPUTexture[] = [];
  const textureMap = new Map<number, UnifiedGPUTexture>();
  
  for (let i = 0; i < model.texturesWithType.length; i++) {
    const texInfo = model.texturesWithType[i];
    if (!texInfo.image) continue;
    try {
      const bitmap = await createImageBitmap(texInfo.image);
      const gpuTexture = UnifiedGPUTexture.create2D(ctx, {
        label: `billboard-bake-tex-${i}`,
        width: bitmap.width, height: bitmap.height,
        format: 'rgba8unorm',
        mipLevelCount: Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1,
        renderTarget: true,
      });
      gpuTexture.uploadImageBitmap(ctx, bitmap);
      gpuTexture.generateMipmaps(ctx);
      textures.push(gpuTexture);
      textureMap.set(i, gpuTexture);
      bitmap.close();
    } catch (err) {
      console.warn(`[BillboardBaker] Failed to upload texture ${i}:`, err);
    }
  }
  
  return { textures, textureMap };
}

// ==================== Mesh Registration ====================

function registerModelMeshes(
  renderer: ObjectRendererGPU,
  model: GLBModel,
  textureMap: Map<number, UnifiedGPUTexture>,
): number[] {
  const meshIds: number[] = [];
  
  for (const mesh of model.meshes) {
    if (!mesh.positions || !mesh.normals) continue;
    
    const matIdx = mesh.materialIndex ?? 0;
    const glbMat = model.materials[matIdx];
    
    const gpuMaterial: GPUMaterial = {
      albedo: glbMat ? [glbMat.baseColorFactor[0], glbMat.baseColorFactor[1], glbMat.baseColorFactor[2]] : [0.7, 0.7, 0.7],
      metallic: glbMat?.metallicFactor ?? 0.0,
      roughness: glbMat?.roughnessFactor ?? 0.5,
      normalScale: glbMat?.normalScale ?? 1.0,
      occlusionStrength: glbMat?.occlusionStrength ?? 1.0,
      alphaMode: glbMat?.alphaMode ?? 'OPAQUE',
      alphaCutoff: glbMat?.alphaCutoff ?? 0.5,
      emissive: glbMat?.emissiveFactor ?? [0, 0, 0],
      doubleSided: glbMat?.doubleSided ?? false,
    };
    
    if (glbMat) {
      const textures: GPUMaterialTextures = {};
      if (glbMat.baseColorTextureIndex !== undefined) textures.baseColor = textureMap.get(glbMat.baseColorTextureIndex);
      if (glbMat.normalTextureIndex !== undefined) textures.normal = textureMap.get(glbMat.normalTextureIndex);
      if (glbMat.metallicRoughnessTextureIndex !== undefined) textures.metallicRoughness = textureMap.get(glbMat.metallicRoughnessTextureIndex);
      if (glbMat.occlusionTextureIndex !== undefined) textures.occlusion = textureMap.get(glbMat.occlusionTextureIndex);
      if (glbMat.emissiveTextureIndex !== undefined) textures.emissive = textureMap.get(glbMat.emissiveTextureIndex);
      gpuMaterial.textures = textures;
    }
    
    meshIds.push(renderer.addMesh({
      positions: mesh.positions, normals: mesh.normals,
      uvs: mesh.uvs ?? undefined, indices: mesh.indices ?? undefined,
      material: gpuMaterial,
    }));
  }
  
  return meshIds;
}

// ==================== Single View Rendering ====================

/**
 * Render one view of the model and read back pixels as ImageData.
 */
async function renderView(
  ctx: GPUContext,
  session: BakeSession,
  angle: number,
  resolution: number,
  bgColor: [number, number, number, number],
): Promise<ImageData> {
  const { renderer, sceneEnv, colorTexture, depthTexture, center, maxExtent } = session;
  
  // Camera setup
  const cameraDistance = maxExtent * 3;
  const cameraPos: [number, number, number] = [
    center[0] + Math.sin(angle) * cameraDistance,
    center[1],
    center[2] + Math.cos(angle) * cameraDistance,
  ];
  
  const viewMatrix = mat4.create();
  mat4.lookAt(viewMatrix, cameraPos, center, [0, 1, 0]);
  
  const orthoSize = maxExtent * 1.1;
  const nearDist = 0.01;
  const farDist = cameraDistance + maxExtent * 2;
  const projMatrix = mat4.create();
  // Use orthoZO for WebGPU [0,1] depth range, swap near/far for reversed-Z
  mat4.orthoZO(projMatrix, -orthoSize, orthoSize, -orthoSize, orthoSize, farDist, nearDist);
  
  const viewProj = mat4.create();
  mat4.multiply(viewProj, projMatrix, viewMatrix);
  
  const renderParams: ObjectRenderParams = {
    viewProjectionMatrix: viewProj,
    cameraPosition: cameraPos,
    lightDirection: [0.3, 0.8, 0.5],
    lightColor: [1.0, 1.0, 0.95],
    ambientIntensity: 0.6,
    shadowEnabled: false,
    csmEnabled: false,
  };
  
  // Record GPU commands
  const encoder = ctx.device.createCommandEncoder({ label: 'billboard-bake-view' });
  
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: colorTexture.createView(),
      loadOp: 'clear', storeOp: 'store',
      clearValue: { r: bgColor[0], g: bgColor[1], b: bgColor[2], a: bgColor[3] },
    }],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthLoadOp: 'clear', depthStoreOp: 'store',
      depthClearValue: 0.0,
    },
  });
  
  renderer.renderWithSceneEnvironment(pass, renderParams, sceneEnv);
  pass.end();
  
  // Read back float16 pixels
  const floatBytesPerRow = Math.ceil((resolution * 8) / 256) * 256;
  const readbackBuf = ctx.device.createBuffer({
    label: 'billboard-bake-readback',
    size: floatBytesPerRow * resolution,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  
  encoder.copyTextureToBuffer(
    { texture: colorTexture },
    { buffer: readbackBuf, bytesPerRow: floatBytesPerRow, rowsPerImage: resolution },
    { width: resolution, height: resolution },
  );
  
  ctx.queue.submit([encoder.finish()]);
  
  await readbackBuf.mapAsync(GPUMapMode.READ);
  const rawData = new Uint16Array(readbackBuf.getMappedRange().slice(0));
  readbackBuf.unmap();
  readbackBuf.destroy();
  
  // Convert float16 RGBA → sRGB uint8
  return convertFloat16ToImageData(rawData, resolution, floatBytesPerRow);
}

// ==================== Pixel Conversion ====================

function convertFloat16ToImageData(rawData: Uint16Array, resolution: number, floatBytesPerRow: number): ImageData {
  const imageData = new ImageData(resolution, resolution);
  const pixelsPerRow = floatBytesPerRow / 2; // float16 = 2 bytes
  
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const srcIdx = y * pixelsPerRow + x * 4;
      const dstIdx = (y * resolution + x) * 4;
      
      const r = clamp01(float16ToNumber(rawData[srcIdx + 0]));
      const g = clamp01(float16ToNumber(rawData[srcIdx + 1]));
      const b = clamp01(float16ToNumber(rawData[srcIdx + 2]));
      const a = clamp01(float16ToNumber(rawData[srcIdx + 3]));
      
      imageData.data[dstIdx + 0] = Math.round(linearToSRGB(r) * 255);
      imageData.data[dstIdx + 1] = Math.round(linearToSRGB(g) * 255);
      imageData.data[dstIdx + 2] = Math.round(linearToSRGB(b) * 255);
      imageData.data[dstIdx + 3] = Math.round(a * 255);
    }
  }
  
  return imageData;
}

function float16ToNumber(h: number): number {
  const sign = (h >> 15) & 0x1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return (sign ? -1 : 1) * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction === 0 ? (sign ? -Infinity : Infinity) : NaN;
  return (sign ? -1 : 1) * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function linearToSRGB(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055;
}

function clamp01(v: number): number {
  return Math.min(1.0, Math.max(0.0, v));
}

// ==================== Atlas Compositing ====================

function createAtlasCanvas(resolution: number, viewCount: number, bgColor: [number, number, number, number]): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = resolution * viewCount;
  canvas.height = resolution;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `rgba(${bgColor[0] * 255}, ${bgColor[1] * 255}, ${bgColor[2] * 255}, ${bgColor[3]})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

function blitViewToAtlas(atlas: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }, imageData: ImageData, viewIndex: number, resolution: number): void {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = resolution;
  tempCanvas.height = resolution;
  const tempCtx = tempCanvas.getContext('2d')!;
  tempCtx.putImageData(imageData, 0, 0);
  atlas.ctx.drawImage(tempCanvas, viewIndex * resolution, 0);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error('Failed to create PNG blob')),
      'image/png'
    );
  });
}

// ==================== Canvas 2D Fallback ====================

async function bakeCanvas2D(model: GLBModel, options: BillboardBakeOptions = {}): Promise<BillboardBakeResult> {
  const viewCount = options.viewCount ?? 8;
  const resolution = options.resolution ?? 1024;
  const bgColor = options.backgroundColor ?? [0, 0, 0, 0];
  
  const bounds = computeBoundsFromGLB(model);
  if (!bounds) throw new Error('Model has no geometry — cannot generate billboard');
  
  const center = vec3.fromValues(
    (bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2,
  );
  const maxExtent = Math.max(
    (bounds.max[0] - bounds.min[0]) / 2, (bounds.max[1] - bounds.min[1]) / 2, (bounds.max[2] - bounds.min[2]) / 2,
  );
  
  const atlas = createAtlasCanvas(resolution, viewCount, bgColor);
  const viewCanvas = document.createElement('canvas');
  viewCanvas.width = resolution;
  viewCanvas.height = resolution;
  const viewCtx = viewCanvas.getContext('2d')!;
  
  for (let i = 0; i < viewCount; i++) {
    const angle = (i / viewCount) * Math.PI * 2;
    viewCtx.clearRect(0, 0, resolution, resolution);
    renderModelViewCanvas2D(viewCtx, model, center, maxExtent, angle, resolution);
    atlas.ctx.drawImage(viewCanvas, i * resolution, 0);
  }
  
  const blob = await canvasToBlob(atlas.canvas);
  return { albedoAtlas: blob, atlasWidth: resolution * viewCount, atlasHeight: resolution, viewCount, resolution };
}

// ==================== Canvas 2D Software Renderer ====================

function renderModelViewCanvas2D(
  ctx: CanvasRenderingContext2D, model: GLBModel,
  center: vec3, maxExtent: number, angle: number, resolution: number,
): void {
  const eye = vec3.fromValues(
    center[0] + Math.sin(angle) * maxExtent * 3, center[1],
    center[2] + Math.cos(angle) * maxExtent * 3,
  );
  
  const viewMatrix = mat4.create();
  mat4.lookAt(viewMatrix, eye, center, [0, 1, 0]);
  const projMatrix = mat4.create();
  mat4.ortho(projMatrix, -maxExtent * 1.1, maxExtent * 1.1, -maxExtent * 1.1, maxExtent * 1.1, 0.01, maxExtent * 10);
  const viewProj = mat4.create();
  mat4.multiply(viewProj, projMatrix, viewMatrix);
  const lightDir = vec3.normalize(vec3.create(), vec3.fromValues(0.3, 0.8, 0.5));
  
  for (const mesh of model.meshes) {
    if (!mesh.positions || !mesh.indices) continue;
    const { positions, indices, normals } = mesh;
    
    let baseColor: [number, number, number] = [0.5, 0.5, 0.5];
    if (mesh.materialIndex !== undefined && model.materials[mesh.materialIndex]) {
      const m = model.materials[mesh.materialIndex];
      baseColor = [m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2]];
    }
    
    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
      const p0 = projectVertex(positions, i0, viewProj, resolution);
      const p1 = projectVertex(positions, i1, viewProj, resolution);
      const p2 = projectVertex(positions, i2, viewProj, resolution);
      if (!p0 || !p1 || !p2) continue;
      
      const cross = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
      if (cross < 0) continue;
      
      let shade = 0.6;
      if (normals) {
        const nx = (normals[i0 * 3] + normals[i1 * 3] + normals[i2 * 3]) / 3;
        const ny = (normals[i0 * 3 + 1] + normals[i1 * 3 + 1] + normals[i2 * 3 + 1]) / 3;
        const nz = (normals[i0 * 3 + 2] + normals[i1 * 3 + 2] + normals[i2 * 3 + 2]) / 3;
        const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nLen > 0.001) {
          shade = 0.5 + 0.5 * Math.max(0, (nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]) / nLen);
        }
      }
      
      const r = Math.min(255, Math.floor(baseColor[0] * shade * 255));
      const g = Math.min(255, Math.floor(baseColor[1] * shade * 255));
      const b = Math.min(255, Math.floor(baseColor[2] * shade * 255));
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 1.0)`;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
      ctx.closePath(); ctx.fill();
    }
  }
}

function projectVertex(positions: Float32Array, index: number, viewProj: mat4, resolution: number): [number, number] | null {
  const x = positions[index * 3], y = positions[index * 3 + 1], z = positions[index * 3 + 2];
  const clipX = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
  const clipY = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
  const clipW = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
  if (clipW <= 0) return null;
  return [(clipX / clipW * 0.5 + 0.5) * resolution, (1.0 - (clipY / clipW * 0.5 + 0.5)) * resolution];
}