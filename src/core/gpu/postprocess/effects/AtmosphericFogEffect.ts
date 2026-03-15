/**
 * AtmosphericFogEffect - Combined aerial perspective haze + height fog
 *
 * Runs as a post-process effect between SSAO and Composite (order 150).
 * Reads HDR scene color + depth, reconstructs world positions,
 * and blends haze / fog in HDR space before tonemapping.
 *
 * Two independent layers:
 * 1. Aerial Perspective (Haze) — distant objects fade to sky horizon color
 *    with Rayleigh-like wavelength-dependent extinction.
 * 2. Height Fog — exponential density fog that hugs the ground, with
 *    Henyey-Greenstein forward scattering toward the sun.
 */

import { mat4 } from 'gl-matrix';
import { BaseEffect, type EffectContext, type StandardInput } from '../PostProcessPipeline';
import fogShader from '../shaders/atmospheric-fog.wgsl?raw';

// ========== Config ==========

/**
 * Atmospheric fog configuration exposed to UI
 */
export interface AtmosphericFogConfig {
  /** Master enable for the whole effect */
  enabled?: boolean;

  // Aerial perspective (haze)
  /** Visibility distance in world units — maps to extinction = 1/distance */
  visibilityDistance?: number;
  /** Haze blend intensity multiplier (0–2) */
  hazeIntensity?: number;
  /** Altitude scale height for haze falloff (world units) */
  hazeScaleHeight?: number;

  // Height fog
  /** Enable the height fog layer */
  heightFogEnabled?: boolean;
  /** Distance in world units where fog reaches ~95% opacity at fogHeight */
  fogVisibilityDistance?: number;
  /** Fog absorption mode: 'exp' (gradual) or 'exp2' (clear near, sharp wall) */
  fogMode?: 'exp' | 'exp2';
  /** World Y where fog is densest */
  fogHeight?: number;
  /** How quickly fog thins above fogHeight (0.005–1) */
  fogHeightFalloff?: number;
  /** Fog color (RGB, 0–1) */
  fogColor?: [number, number, number];
  /** Mie-like forward scattering intensity toward the sun (0–1) */
  fogSunScattering?: number;
}

const DEFAULT_CONFIG: Required<AtmosphericFogConfig> = {
  enabled: false,

  // Haze
  visibilityDistance: 3000,
  hazeIntensity: 0.8,
  hazeScaleHeight: 800,

  // Height fog
  heightFogEnabled: false,
  fogVisibilityDistance: 1500,
  fogMode: 'exp' as const,
  fogHeight: 0,
  fogHeightFalloff: 0.05,
  fogColor: [0.85, 0.88, 0.92],
  fogSunScattering: 0.3,
};

// Uniform buffer size in bytes — must match FogUniforms in WGSL
// 176 bytes total, rounded up to 16-byte alignment
const UNIFORM_SIZE = 176;

// ========== Effect Class ==========

/**
 * AtmosphericFogEffect — fullscreen post-process for haze + height fog.
 *
 * Slots into PostProcessPipeline at order 150 (between SSAO @100 and Composite @200).
 * Reads 'color' + 'depth', writes modified 'color' back via an intermediate texture.
 */
export class AtmosphericFogEffect extends BaseEffect {
  readonly name = 'atmosphericFog';
  readonly inputs: (StandardInput | string)[] = ['color', 'depth'];
  readonly outputs: string[] = []; // Outputs directly to pipeline color

  private config: Required<AtmosphericFogConfig>;

  // GPU resources
  private pipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  // Per-frame sun/light data (set by pipeline before execute)
  private sunDirection: [number, number, number] = [0.3, 0.8, 0.5];
  private sunColor: [number, number, number] = [1, 1, 0.95];
  private sunIntensity: number = 20;

  constructor(config: AtmosphericFogConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========== Public API ==========

  setConfig(config: Partial<AtmosphericFogConfig>): void {
    Object.assign(this.config, config);
  }

  getConfig(): Required<AtmosphericFogConfig> {
    return { ...this.config };
  }

  /**
   * Called by the pipeline each frame to provide current sun data.
   * This avoids adding sun direction to the generic EffectUniforms interface.
   */
  setSunData(
    direction: [number, number, number],
    color: [number, number, number],
    intensity: number,
  ): void {
    this.sunDirection = direction;
    this.sunColor = color;
    this.sunIntensity = intensity;
  }

  // ========== Lifecycle ==========

  protected onInit(): void {
    this.createPipeline();
    this.createResources();
  }

  protected onDestroy(): void {
    this.uniformBuffer?.destroy();
  }

  // ========== Execute ==========

  execute(ctx: EffectContext): void {
    if (!this.pipeline || !this.sampler || !this.uniformBuffer) return;

    const { encoder, uniforms } = ctx;
    const colorTexture = ctx.getTexture('color');
    const depthTexture = ctx.getTexture('depth');

    // Upload uniforms
    this.uploadUniforms(uniforms);

    // Strategy: copy scene color → temp buffer (color has CopySrc), then
    // render fog reading from temp and writing directly to scene color.
    // This avoids needing CopySrc on pool textures.
    const tempBuffer = ctx.acquireBuffer('rgba16float', 'atmospheric-fog-input');

    // Copy current scene color to temp (scene-color-hdr has copySrc usage)
    encoder.copyTextureToTexture(
      { texture: colorTexture.texture },
      { texture: tempBuffer.texture },
      { width: this.width, height: this.height, depthOrArrayLayers: 1 },
    );

    // Create bind group reading from the temp copy
    const bindGroup = this.ctx.device.createBindGroup({
      label: 'atmospheric-fog-bind-group',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: tempBuffer.view },
        { binding: 1, resource: depthTexture.view },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: this.uniformBuffer } },
      ],
    });

    // Render fog result directly to the scene color texture
    const pass = encoder.beginRenderPass({
      label: 'atmospheric-fog-pass',
      colorAttachments: [{
        view: colorTexture.view,
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    ctx.fullscreenQuad.draw(pass);
    pass.end();

    // Release the temp buffer
    ctx.releaseBuffer(tempBuffer);
  }

  // ========== Private ==========

  private createPipeline(): void {
    const module = this.ctx.device.createShaderModule({
      label: 'atmospheric-fog-shader',
      code: fogShader,
    });

    this.pipeline = this.ctx.device.createRenderPipeline({
      label: 'atmospheric-fog-pipeline',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs_main',
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float' }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private createResources(): void {
    this.sampler = this.ctx.device.createSampler({
      label: 'atmospheric-fog-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.uniformBuffer = this.ctx.device.createBuffer({
      label: 'atmospheric-fog-uniforms',
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Pack FogUniforms and upload to GPU.
   *
   * Layout matches the WGSL struct exactly (176 bytes):
   *   mat4x4f inverseViewProj  [0..63]
   *   vec3f   cameraPosition   [64..75]
   *   f32     near             [76]
   *   f32     far              [80]
   *   f32     _pad0            [84]
   *   f32     _pad1            [88]
   *   f32     _pad2            [92]
   *   f32     hazeExtinction   [96]
   *   f32     hazeIntensity    [100]
   *   f32     hazeScaleHeight  [104]
   *   f32     hazeEnabled      [108]
   *   f32     fogDensity       [112]
   *   f32     fogHeight        [116]
   *   f32     fogHeightFalloff [120]
   *   f32     fogEnabled       [124]
   *   vec3f   fogColor         [128..139]
   *   f32     fogSunScattering [140]
   *   vec3f   sunDirection     [144..155]
   *   f32     sunIntensity     [156]
   *   vec3f   sunColor         [160..171]
   *   f32     _pad3            [172]
   */
  private uploadUniforms(uniforms: EffectContext['uniforms']): void {
    if (!this.uniformBuffer) return;

    const data = new Float32Array(UNIFORM_SIZE / 4); // 44 floats

    // Compute inverse view-projection matrix
    const invViewProj = mat4.create();
    const vp = mat4.create();
    mat4.multiply(vp, uniforms.projectionMatrix as unknown as mat4, uniforms.viewMatrix as unknown as mat4);
    mat4.invert(invViewProj, vp);

    // inverseViewProj (mat4x4f = 16 floats, offset 0)
    data.set(new Float32Array(invViewProj as unknown as ArrayBuffer), 0);

    // cameraPosition (vec3f, offset 16 floats = 64 bytes)
    // Extract from inverse view matrix: column 3 (translation)
    const invView = uniforms.inverseViewMatrix;
    data[16] = invView[12]; // x
    data[17] = invView[13]; // y
    data[18] = invView[14]; // z

    // near, far (offset 19, 20)
    data[19] = uniforms.near;
    data[20] = uniforms.far;
    // fogMode at 21 (repurposes _pad0): 0.0 = exp, 1.0 = exp2
    data[21] = this.config.fogMode === 'exp2' ? 1.0 : 0.0;
    data[22] = 0;
    data[23] = 0;

    // Haze params (offset 24)
    const hazeEnabled = this.config.enabled; // master + haze always enabled when effect is enabled
    data[24] = 1.0 / Math.max(1.0, this.config.visibilityDistance); // hazeExtinction
    data[25] = this.config.hazeIntensity;
    data[26] = this.config.hazeScaleHeight;
    data[27] = hazeEnabled ? 1.0 : 0.0;

    // Height fog params (offset 28)
    // Convert visibility distance → density: exp(-density * dist) ≈ 0.05 at visibilityDistance
    // So density = -ln(0.05) / distance ≈ 3.0 / distance
    data[28] = 3.0 / Math.max(1.0, this.config.fogVisibilityDistance);
    data[29] = this.config.fogHeight;
    data[30] = this.config.fogHeightFalloff;
    data[31] = this.config.heightFogEnabled ? 1.0 : 0.0;

    // fogColor (vec3f, offset 32) + fogSunScattering (offset 35)
    data[32] = this.config.fogColor[0];
    data[33] = this.config.fogColor[1];
    data[34] = this.config.fogColor[2];
    data[35] = this.config.fogSunScattering;

    // sunDirection (vec3f, offset 36) + sunIntensity (offset 39)
    data[36] = this.sunDirection[0];
    data[37] = this.sunDirection[1];
    data[38] = this.sunDirection[2];
    data[39] = this.sunIntensity;

    // sunColor (vec3f, offset 40) + _pad3 (offset 43)
    data[40] = this.sunColor[0];
    data[41] = this.sunColor[1];
    data[42] = this.sunColor[2];
    data[43] = 0;

    this.ctx.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }
}
