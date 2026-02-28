import { Component } from '../Component';
import type { ComponentType } from '../types';
import type { DebugTextureManager } from '../../gpu/renderers/DebugTextureManager';

/**
 * Resolution options for reflection probe cubemap faces.
 */
export type ProbeResolution = 64 | 128 | 256;

/**
 * Bake state lifecycle for a reflection probe.
 */
export type ProbeBakeState = 'none' | 'pending' | 'baking' | 'baked';

/**
 * ReflectionProbeComponent — per-entity reflection probe for metallic objects.
 *
 * Captures a low-res cubemap of nearby geometry (opaques + ground only, no sky)
 * from the entity's AABB center. At render time the shader samples the probe
 * cubemap first; for transparent/black pixels (no geometry hit) it falls through
 * to the global IBL specular cubemap.
 *
 * When a probe is baked, SSR is bypassed for that entity — the probe cubemap
 * combined with IBL fallback provides sufficient reflections.
 *
 * Usage:
 *   entity.addComponent(new ReflectionProbeComponent());
 *   // Click "Bake" in UI or set bakeState = 'pending' programmatically
 */
export class ReflectionProbeComponent extends Component {
  readonly type: ComponentType = 'reflection-probe';

  /**
   * Whether the reflection probe is enabled for this entity.
   * When disabled, the entity falls back to SSR or IBL-only reflections.
   */
  enabled: boolean = true;

  /**
   * Resolution per cubemap face (width = height).
   * Higher = better quality, more VRAM and bake time.
   */
  resolution: ProbeResolution = 128;

  /**
   * Reflection intensity multiplier (0 = no reflection, 1 = full).
   */
  intensity: number = 1.0;

  /**
   * Current bake state lifecycle.
   * - 'none'    — no cubemap baked yet
   * - 'pending' — user requested bake, system will pick it up next frame
   * - 'baking'  — capture in progress
   * - 'baked'   — cubemap ready for shader sampling
   */
  bakeState: ProbeBakeState = 'none';

  /**
   * The GPU cubemap texture created by the capture renderer.
   * null until first bake completes.
   */
  cubemapTexture: GPUTexture | null = null;

  /**
   * Cubemap texture view for shader binding (cube view dimension).
   * null until first bake completes.
   */
  cubemapView: GPUTextureView | null = null;

  /**
   * Sampler for the probe cubemap (trilinear filtering with mips).
   * Created once, reused across re-bakes.
   */
  cubemapSampler: GPUSampler | null = null;

  /**
   * World-space position where the probe was captured.
   * Updated each bake from entity's AABB center.
   */
  capturePosition: [number, number, number] = [0, 0, 0];

  /**
   * Whether to automatically re-bake when the entity's transform changes.
   */
  autoBakeOnTransformChange: boolean = false;

  /**
   * Track the last model matrix hash to detect transform changes for auto-bake.
   * @internal
   */
  _lastTransformHash: number = 0;

  /**
   * Whether debug face visualizations are registered.
   * @internal
   */
  _debugRegistered = false;

  /**
   * Request a bake. Sets state to 'pending' so the system picks it up.
   */
  requestBake(): void {
    if (this.enabled) {
      this.bakeState = 'pending';
    }
  }

  /**
   * Whether a baked cubemap is available for shader use.
   */
  get isBaked(): boolean {
    return this.bakeState === 'baked' && this.cubemapView !== null;
  }

  /**
   * Provide the cubemap view for shader binding.
   */
  getGPUResource(name: string): GPUBindingResource | null {
    if (name === 'reflectionProbeCubemap' && this.cubemapView) {
      return this.cubemapView;
    }
    if (name === 'reflectionProbeSampler' && this.cubemapSampler) {
      return this.cubemapSampler;
    }
    return null;
  }

  // ==================== Debug Texture Registration ====================

  private static readonly FACE_NAMES = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];

  /**
   * Register all 6 cubemap faces with the DebugTextureManager.
   * Call after bake completes.
   */
  registerDebugTextures(debugMgr: DebugTextureManager): void {
    if (!this.cubemapTexture || this._debugRegistered) return;

    const texture = this.cubemapTexture;
    for (let face = 0; face < 6; face++) {
      const faceIndex = face;
      debugMgr.register(
        `Probe ${ReflectionProbeComponent.FACE_NAMES[face]}`,
        'float',
        () => {
          try {
            return texture.createView({
              dimension: '2d',
              baseArrayLayer: faceIndex,
              arrayLayerCount: 1,
              baseMipLevel: 0,
              mipLevelCount: 1,
            });
          } catch {
            return null;
          }
        },
        { colormap: 'color', enabled: false },
      );
    }
    this._debugRegistered = true;
  }

  /**
   * Unregister debug textures from the manager.
   */
  unregisterDebugTextures(debugMgr: DebugTextureManager): void {
    if (!this._debugRegistered) return;
    for (const name of ReflectionProbeComponent.FACE_NAMES) {
      debugMgr.unregister(`Probe ${name}`);
    }
    this._debugRegistered = false;
  }

  /**
   * Toggle debug visualization of all 6 faces.
   * @returns Whether debug is now enabled
   */
  toggleDebugTextures(debugMgr: DebugTextureManager): boolean {
    if (!this._debugRegistered) return false;
    const firstEnabled = debugMgr.isEnabled('Probe +X');
    const newState = !firstEnabled;
    for (const name of ReflectionProbeComponent.FACE_NAMES) {
      debugMgr.setEnabled(`Probe ${name}`, newState);
    }
    return newState;
  }

  /**
   * Check if debug visualization is currently active.
   */
  isDebugActive(debugMgr: DebugTextureManager): boolean {
    return this._debugRegistered && debugMgr.isEnabled('Probe +X');
  }

  /**
   * Destroy GPU resources when component is removed.
   */
  destroy(): void {
    if (this.cubemapTexture) {
      this.cubemapTexture.destroy();
      this.cubemapTexture = null;
    }
    this.cubemapView = null;
    this.cubemapSampler = null;
    this.bakeState = 'none';
    this._debugRegistered = false;
  }

  serialize(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      resolution: this.resolution,
      intensity: this.intensity,
      autoBakeOnTransformChange: this.autoBakeOnTransformChange,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.enabled !== undefined) this.enabled = data.enabled as boolean;
    if (data.resolution !== undefined) this.resolution = data.resolution as ProbeResolution;
    if (data.intensity !== undefined) this.intensity = data.intensity as number;
    if (data.autoBakeOnTransformChange !== undefined) {
      this.autoBakeOnTransformChange = data.autoBakeOnTransformChange as boolean;
    }
  }
}