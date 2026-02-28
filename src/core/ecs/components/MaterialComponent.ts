import { Component } from '../Component';
import type { ComponentType } from '../types';
import type {
  ProceduralTextureParams,
  TextureTargetSlot,
} from '../../gpu/renderers/ProceduralTextureGenerator';

/**
 * Material component — PBR material properties.
 *
 * Maps to the MaterialUniforms struct in the shader template.
 * Does NOT hold GPU resources — those are on MeshComponent.
 */
export class MaterialComponent extends Component {
  readonly type: ComponentType = 'material';

  albedo: [number, number, number] = [0.7, 0.7, 0.7];
  metallic: number = 0.0;
  roughness: number = 0.5;
  normalScale: number = 1.0;
  occlusionStrength: number = 1.0;
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND' = 'OPAQUE';
  alphaCutoff: number = 0.5;
  emissive: [number, number, number] = [0, 0, 0];
  doubleSided: boolean = false;
  ior: number = 1.5;
  clearcoatFactor: number = 0.0;
  clearcoatRoughness: number = 0.0;
  unlit: boolean = false;

  /** Texture flags: [hasBaseColor, hasNormal, hasMetallicRoughness, hasOcclusion] */
  private _textureFlags: [number, number, number, number] = [0, 0, 0, 0];

  /**
   * Indicates if the textures come attached to the mesh (like imported models)
   */
  private _hasIntrinsicTextures: boolean = false;

  /**
   * Read-only access to texture flags.
   * [hasBaseColor, hasNormal, hasMetallicRoughness, hasOcclusion]
   */
  get textureFlags(): readonly [number, number, number, number] {
    return this._textureFlags;
  }

  /**
   * Recompute texture flags from the proceduralTextures map.
   * Call this after adding/removing procedural texture definitions.
   */
  updateTextureFlags(): void {
    this._textureFlags = [
      this.proceduralTextures.has('baseColor') ? 1 : 0,
      0, // normal maps not supported via procedural textures currently
      (this.proceduralTextures.has('metallic') || this.proceduralTextures.has('roughness')) ? 1 : 0,
      this.proceduralTextures.has('occlusion') ? 1 : 0,
    ];
  }

  /**
   * Set texture flags directly (for model-loaded textures from GLB).
   */
  setTextureFlags(flags: [number, number, number, number]): void {
    this._textureFlags = [...flags] as [number, number, number, number];
  }

  get hasIntrinsicTextures() {
    return this._hasIntrinsicTextures;
  }

  set hasIntrinsicTextures(has: boolean) {
    this._hasIntrinsicTextures = has;
  }

  /**
   * Procedural texture definitions per PBR target slot.
   * Params only — GPU textures are regenerated on load.
   */
  proceduralTextures: Map<TextureTargetSlot, ProceduralTextureParams> = new Map();

  serialize(): Record<string, unknown> {
    // Serialize procedural textures as plain objects
    const procTex: Record<string, ProceduralTextureParams> = {};
    for (const [slot, params] of this.proceduralTextures) {
      procTex[slot] = { ...params, colorRamp: { ...params.colorRamp } };
    }

    return {
      albedo: [...this.albedo],
      metallic: this.metallic,
      roughness: this.roughness,
      normalScale: this.normalScale,
      occlusionStrength: this.occlusionStrength,
      alphaMode: this.alphaMode,
      alphaCutoff: this.alphaCutoff,
      emissive: [...this.emissive],
      doubleSided: this.doubleSided,
      ior: this.ior,
      clearcoatFactor: this.clearcoatFactor,
      clearcoatRoughness: this.clearcoatRoughness,
      unlit: this.unlit,
      proceduralTextures: Object.keys(procTex).length > 0 ? procTex : undefined,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    if (data.albedo) this.albedo = data.albedo as [number, number, number];
    if (data.metallic !== undefined) this.metallic = data.metallic as number;
    if (data.roughness !== undefined) this.roughness = data.roughness as number;
    if (data.normalScale !== undefined)
      this.normalScale = data.normalScale as number;
    if (data.occlusionStrength !== undefined)
      this.occlusionStrength = data.occlusionStrength as number;
    if (data.alphaMode) this.alphaMode = data.alphaMode as 'OPAQUE' | 'MASK' | 'BLEND';
    if (data.alphaCutoff !== undefined)
      this.alphaCutoff = data.alphaCutoff as number;
    if (data.emissive)
      this.emissive = data.emissive as [number, number, number];
    if (data.doubleSided !== undefined)
      this.doubleSided = data.doubleSided as boolean;
    if (data.ior !== undefined)
      this.ior = data.ior as number;
    if (data.clearcoatFactor !== undefined)
      this.clearcoatFactor = data.clearcoatFactor as number;
    if (data.clearcoatRoughness !== undefined)
      this.clearcoatRoughness = data.clearcoatRoughness as number;
    if (data.unlit !== undefined)
      this.unlit = data.unlit as boolean;
    if (data.proceduralTextures) {
      const pt = data.proceduralTextures as Record<string, ProceduralTextureParams>;
      this.proceduralTextures.clear();
      for (const [slot, params] of Object.entries(pt)) {
        this.proceduralTextures.set(slot as TextureTargetSlot, params);
      }
    }
  }
}