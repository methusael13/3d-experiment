import { Component } from '../Component';
import type { ComponentType } from '../types';

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

  /** Texture flags: [hasBaseColor, hasNormal, hasMetallicRoughness, hasOcclusion] */
  textureFlags: [number, number, number, number] = [0, 0, 0, 0];

  serialize(): Record<string, unknown> {
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
  }
}