import type { Entity } from '../../../ecs/Entity';
import type { Component } from '../../../ecs/Component';
import type { ShaderResource } from './types';
import type { SceneEnvironment } from '../../renderers/shared/SceneEnvironment';

/**
 * Maps shader resource declarations to actual GPU resources by querying
 * entity components and the scene environment.
 *
 * Given an entity and a ComposedShader's binding layout, produces
 * the GPUBindGroupEntry[] needed for setBindGroup().
 *
 * Resolution strategy:
 * - 'perObject' group resources → query entity components by provider type
 * - 'textures' group resources → query entity's MeshComponent for texture resources
 * - 'environment' group resources → query SceneEnvironment
 */
export class ResourceResolver {
  /**
   * Resolve texture/sampler bind group entries for the textures group (Group 2).
   *
   * @param entity - The entity to resolve resources from
   * @param bindingLayout - The composed shader's binding layout with assigned indices
   * @returns Array of GPUBindGroupEntry for creating a bind group
   */
  resolveTextureBindings(
    entity: Entity,
    bindingLayout: Map<string, ShaderResource & { bindingIndex: number }>,
  ): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [];

    for (const [name, res] of bindingLayout) {
      if (res.group !== 'textures') continue;

      const gpuResource = this.resolveFromEntity(entity, res.provider, name);
      if (gpuResource) {
        entries.push({
          binding: res.bindingIndex,
          resource: gpuResource,
        });
      }
    }

    return entries;
  }

  /**
   * Resolve environment bind group entries for Group 3.
   *
   * @param sceneEnvironment - The scene environment holding shadow maps, IBL textures, etc.
   * @param bindingLayout - The composed shader's environment binding layout
   * @returns Array of GPUBindGroupEntry for creating a bind group
   */
  resolveEnvironmentBindings(
    sceneEnvironment: SceneEnvironment,
    bindingLayout: Map<string, ShaderResource & { bindingIndex: number }>,
  ): GPUBindGroupEntry[] {
    const entries: GPUBindGroupEntry[] = [];

    for (const [name, res] of bindingLayout) {
      if (res.group !== 'environment') continue;

      // SceneEnvironment provides resources by name
      const gpuResource = (sceneEnvironment as unknown as ResourceProvider)
        .getGPUResource?.(name);
      if (gpuResource) {
        entries.push({
          binding: res.bindingIndex,
          resource: gpuResource,
        });
      }
    }

    return entries;
  }

  /**
   * Look up a GPU resource from an entity's components.
   */
  private resolveFromEntity(
    entity: Entity,
    providerType: string,
    resourceName: string,
  ): GPUBindingResource | null {
    // Try to find the component that provides this resource
    // The provider string maps to a component type name
    for (const component of entity.getComponents()) {
      if (
        component.constructor.name === providerType ||
        component.type === providerType.toLowerCase().replace('component', '')
      ) {
        const resource = component.getGPUResource?.(resourceName);
        if (resource) return resource;
      }
    }

    return null;
  }
}

/**
 * Internal interface for objects that can provide GPU resources by name.
 */
interface ResourceProvider {
  getGPUResource?(name: string): GPUBindingResource | null;
}