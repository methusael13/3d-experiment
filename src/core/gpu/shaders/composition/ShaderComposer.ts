import type {
  ShaderFeature,
  ShaderResource,
  ComposedShader,
} from './types';
import { getFeature } from '../features';
import { RES } from './resourceNames';
import { ENVIRONMENT_BINDINGS } from '../../renderers/shared/types';
import objectTemplate from '../templates/object-template.wgsl?raw';

/**
 * Maps canonical environment resource names to fixed ENVIRONMENT_BINDINGS indices.
 * These must match the binding indices used by SceneEnvironment.getBindGroupForMask().
 */
const ENV_RESOURCE_BINDING_INDEX: Record<string, number> = {
  [RES.SHADOW_MAP]: ENVIRONMENT_BINDINGS.SHADOW_MAP,             // 0
  [RES.SHADOW_SAMPLER]: ENVIRONMENT_BINDINGS.SHADOW_SAMPLER,     // 1
  [RES.IBL_DIFFUSE]: ENVIRONMENT_BINDINGS.IBL_DIFFUSE,           // 2
  [RES.IBL_SPECULAR]: ENVIRONMENT_BINDINGS.IBL_SPECULAR,         // 3
  [RES.IBL_BRDF_LUT]: ENVIRONMENT_BINDINGS.BRDF_LUT,            // 4
  [RES.IBL_CUBEMAP_SAMPLER]: ENVIRONMENT_BINDINGS.IBL_CUBE_SAMPLER, // 5
  [RES.IBL_LUT_SAMPLER]: ENVIRONMENT_BINDINGS.IBL_LUT_SAMPLER,  // 6
  [RES.CSM_SHADOW_ARRAY]: ENVIRONMENT_BINDINGS.CSM_SHADOW_ARRAY, // 7
  [RES.CSM_UNIFORMS]: ENVIRONMENT_BINDINGS.CSM_UNIFORMS,        // 8
  [RES.SSR_PREV_FRAME_TEXTURE]: ENVIRONMENT_BINDINGS.SSR_TEXTURE, // 9
  [RES.REFLECTION_PROBE_CUBEMAP]: ENVIRONMENT_BINDINGS.REFLECTION_PROBE_CUBEMAP, // 10
  [RES.REFLECTION_PROBE_SAMPLER]: ENVIRONMENT_BINDINGS.REFLECTION_PROBE_SAMPLER, // 11
};

/**
 * ShaderComposer assembles WGSL from a base template and feature modules.
 *
 * Pipeline:
 * 1. Accepts a list of feature IDs
 * 2. Resolves dependencies (topological sort)
 * 3. Collects all ShaderResource declarations from active features
 * 4. Deduplicates resources by (name, group) — detects type conflicts
 * 5. Assigns binding indices to deduplicated texture/sampler resources
 * 6. Builds the PerObjectUniforms struct additions from uniform resources
 * 7. Injects function definitions (dependency-ordered) into the template
 * 8. Injects vertex/fragment code at template markers
 * 9. Returns ComposedShader with assembled WGSL + layout metadata
 */
export class ShaderComposer {
  /**
   * Compose a shader variant from a set of feature IDs.
   *
   * @param featureIds - Feature IDs to include (e.g., ['shadow', 'ibl', 'textured'])
   * @returns ComposedShader with WGSL source and layout metadata
   */
  compose(featureIds: string[]): ComposedShader {
    // 1. Resolve features and their dependencies
    const orderedFeatures = this.resolveFeatures(featureIds);

    // 2. Collect and deduplicate resources
    const {
      uniformLayout,
      textureBindings,
      environmentBindings,
    } = this.deduplicateResources(orderedFeatures);

    // 3. Generate WGSL snippets for each injection point
    const extraUniformFields = this.buildUniformFields(uniformLayout);
    const extraBindings = this.buildTextureBindings(textureBindings);
    const environmentBindingsWgsl = this.buildEnvironmentBindings(environmentBindings);
    const extraVaryings = this.buildVaryings(orderedFeatures);
    const functions = this.buildFunctions(orderedFeatures);
    const vertexFeatures = this.buildVertexInject(orderedFeatures);
    const fragmentTextureSampling = this.buildFragmentTextureSampling(orderedFeatures);
    const fragmentShadow = this.buildFragmentShadow(orderedFeatures);
    const fragmentAmbient = this.buildFragmentAmbient(orderedFeatures);
    const fragmentPost = this.buildFragmentPost(orderedFeatures);

    // 4. Inject into template
    let wgsl = objectTemplate;
    wgsl = wgsl.replace('/*{{EXTRA_UNIFORM_FIELDS}}*/', extraUniformFields);
    wgsl = wgsl.replace('/*{{EXTRA_BINDINGS}}*/', extraBindings);
    wgsl = wgsl.replace('/*{{ENVIRONMENT_BINDINGS}}*/', environmentBindingsWgsl);
    wgsl = wgsl.replace('/*{{EXTRA_VARYINGS}}*/', extraVaryings);
    wgsl = wgsl.replace('/*{{FUNCTIONS}}*/', functions);
    wgsl = wgsl.replace('/*{{VERTEX_FEATURES}}*/', vertexFeatures);
    const fragmentPreLighting = this.buildFragmentPreLighting(orderedFeatures);
    wgsl = wgsl.replace('/*{{FRAGMENT_TEXTURE_SAMPLING}}*/', fragmentTextureSampling);
    wgsl = wgsl.replace('/*{{FRAGMENT_PRE_LIGHTING}}*/', fragmentPreLighting);
    wgsl = wgsl.replace('/*{{FRAGMENT_SHADOW}}*/', fragmentShadow);
    wgsl = wgsl.replace('/*{{FRAGMENT_AMBIENT}}*/', fragmentAmbient);
    wgsl = wgsl.replace('/*{{FRAGMENT_POST}}*/', fragmentPost);

    // 5. Build the binding layout map with assigned indices
    const bindingLayout = new Map<string, ShaderResource & { bindingIndex: number }>();
    for (const [name, res] of textureBindings) {
      bindingLayout.set(name, res);
    }

    const featureKey = this.buildFeatureKey(featureIds);

    return {
      wgsl,
      uniformLayout,
      bindingLayout,
      featureKey,
      features: orderedFeatures.map((f) => f.id),
    };
  }

  /**
   * Build a deterministic feature key from feature IDs (sorted, '+'-joined).
   */
  buildFeatureKey(featureIds: string[]): string {
    return [...featureIds].sort().join('+');
  }

  // ===================== Resolution =====================

  /**
   * Resolve feature IDs to ordered ShaderFeature objects,
   * including transitive dependencies via topological sort.
   */
  private resolveFeatures(featureIds: string[]): ShaderFeature[] {
    const visited = new Set<string>();
    const ordered: ShaderFeature[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const feature = getFeature(id);

      // Visit dependencies first
      if (feature.dependencies) {
        for (const depId of feature.dependencies) {
          visit(depId);
        }
      }

      ordered.push(feature);
    };

    for (const id of featureIds) {
      visit(id);
    }

    return ordered;
  }

  // ===================== Resource Deduplication =====================

  private deduplicateResources(features: ShaderFeature[]): {
    uniformLayout: Map<string, ShaderResource>;
    textureBindings: Map<string, ShaderResource & { bindingIndex: number }>;
    environmentBindings: Map<string, ShaderResource & { bindingIndex: number }>;
  } {
    const uniformLayout = new Map<string, ShaderResource>();
    const textureResources = new Map<string, ShaderResource>();
    const environmentResources = new Map<string, ShaderResource>();

    for (const feature of features) {
      for (const resource of feature.resources) {
        const existing = this.getExistingResource(
          resource,
          uniformLayout,
          textureResources,
          environmentResources,
        );

        if (existing) {
          // Validate type compatibility
          this.validateResourceConflict(existing, resource, feature.id);
          // Already deduplicated — skip
          continue;
        }

        // New resource
        if (resource.group === 'perObject' && resource.kind === 'uniform') {
          uniformLayout.set(resource.name, resource);
        } else if (resource.group === 'textures') {
          textureResources.set(resource.name, resource);
        } else if (resource.group === 'environment') {
          environmentResources.set(resource.name, resource);
        }
      }
    }

    // Assign binding indices to texture group
    const textureBindings = new Map<string, ShaderResource & { bindingIndex: number }>();
    let texBindingIndex = 0;
    for (const [name, res] of textureResources) {
      textureBindings.set(name, { ...res, bindingIndex: texBindingIndex++ });
    }

    // Assign FIXED binding indices to environment group (must match SceneEnvironment layout)
    const environmentBindings = new Map<string, ShaderResource & { bindingIndex: number }>();
    for (const [name, res] of environmentResources) {
      const fixedIndex = ENV_RESOURCE_BINDING_INDEX[name];
      if (fixedIndex === undefined) {
        throw new Error(
          `[ShaderComposer] Unknown environment resource "${name}". ` +
          `Add it to ENV_RESOURCE_BINDING_INDEX in ShaderComposer.ts.`,
        );
      }
      environmentBindings.set(name, { ...res, bindingIndex: fixedIndex });
    }

    return { uniformLayout, textureBindings, environmentBindings };
  }

  private getExistingResource(
    resource: ShaderResource,
    uniforms: Map<string, ShaderResource>,
    textures: Map<string, ShaderResource>,
    environment: Map<string, ShaderResource>,
  ): ShaderResource | undefined {
    if (resource.group === 'perObject' && resource.kind === 'uniform') {
      return uniforms.get(resource.name);
    }
    if (resource.group === 'textures') {
      return textures.get(resource.name);
    }
    if (resource.group === 'environment') {
      return environment.get(resource.name);
    }
    return undefined;
  }

  private validateResourceConflict(
    existing: ShaderResource,
    incoming: ShaderResource,
    featureId: string,
  ): void {
    const typeMatch =
      existing.kind === incoming.kind &&
      existing.wgslType === incoming.wgslType &&
      existing.textureType === incoming.textureType &&
      existing.samplerType === incoming.samplerType;

    if (!typeMatch) {
      throw new Error(
        `[ShaderComposer] Resource type conflict for "${incoming.name}" in group "${incoming.group}". ` +
          `Feature "${featureId}" declares ${incoming.kind}/${incoming.wgslType ?? incoming.textureType ?? incoming.samplerType} ` +
          `but existing declaration is ${existing.kind}/${existing.wgslType ?? existing.textureType ?? existing.samplerType}. ` +
          `Rename one of the resources to resolve the conflict.`,
      );
    }
  }

  // ===================== WGSL Generation =====================

  /**
   * Build additional uniform fields to inject into MaterialUniforms struct.
   */
  private buildUniformFields(uniformLayout: Map<string, ShaderResource>): string {
    if (uniformLayout.size === 0) return '';

    const lines: string[] = [];
    for (const [name, res] of uniformLayout) {
      lines.push(`  ${name}: ${res.wgslType},`);
    }
    return lines.join('\n');
  }

  /**
   * Build texture/sampler binding declarations for Group 2.
   */
  private buildTextureBindings(
    bindings: Map<string, ShaderResource & { bindingIndex: number }>,
  ): string {
    if (bindings.size === 0) return '';

    const lines: string[] = [];
    for (const [name, res] of bindings) {
      if (res.kind === 'texture') {
        lines.push(
          `@group(2) @binding(${res.bindingIndex}) var ${name}: ${res.textureType};`,
        );
      } else if (res.kind === 'sampler') {
        lines.push(
          `@group(2) @binding(${res.bindingIndex}) var ${name}: ${res.samplerType};`,
        );
      }
    }
    return lines.join('\n');
  }

  /**
   * Build environment binding declarations for Group 3.
   *
   * For uniform resources that reference structs (e.g., CSMUniforms), the struct
   * definition must appear BEFORE the binding declaration in WGSL. Since
   * ENVIRONMENT_BINDINGS is injected before FUNCTIONS in the template, we
   * forward-declare the required struct here.
   */
  private buildEnvironmentBindings(
    bindings: Map<string, ShaderResource & { bindingIndex: number }>,
  ): string {
    if (bindings.size === 0) return '';

    const structDefs: string[] = [];
    const lines: string[] = [];
    
    for (const [name, res] of bindings) {
      if (res.kind === 'texture') {
        lines.push(
          `@group(3) @binding(${res.bindingIndex}) var ${name}: ${res.textureType};`,
        );
      } else if (res.kind === 'sampler') {
        lines.push(
          `@group(3) @binding(${res.bindingIndex}) var ${name}: ${res.samplerType};`,
        );
      } else if (res.kind === 'uniform') {
        // Uniform buffers in environment group (e.g., CSMUniforms)
        // Forward-declare the struct before the binding so WGSL can resolve the type.
        // The full struct definition also appears in the feature's functions block;
        // we emit a minimal forward definition here.  WGSL does not allow duplicate
        // struct definitions, so the feature's functions block should NOT re-declare it.
        // Since the shadow feature already puts CSMUniforms in its functions block and
        // FUNCTIONS comes after ENVIRONMENT_BINDINGS, we need the struct HERE.
        if (name === 'csmUniforms') {
          structDefs.push(`
struct CSMUniforms {
  viewProjectionMatrices: array<mat4x4f, 4>,
  cascadeSplits: vec4f,
  config: vec4f,
  cameraForward: vec4f,
}`);
        }
        lines.push(
          `@group(3) @binding(${res.bindingIndex}) var<uniform> ${name}: CSMUniforms;`,
        );
      }
    }
    
    // Struct definitions first, then binding declarations
    return [...structDefs, ...lines].join('\n');
  }

  /**
   * Build additional VertexOutput varying fields.
   */
  private buildVaryings(features: ShaderFeature[]): string {
    const varyings: string[] = [];
    for (const feature of features) {
      if (feature.varyings) {
        varyings.push(feature.varyings);
      }
    }
    return varyings.join('\n');
  }

  /**
   * Build function definitions from all features (dependency order).
   */
  private buildFunctions(features: ShaderFeature[]): string {
    const blocks: string[] = [];
    for (const feature of features) {
      if (feature.functions && feature.functions.trim().length > 0) {
        blocks.push(`// ---- Feature: ${feature.id} ----`);
        blocks.push(feature.functions);
      }
    }
    return blocks.join('\n');
  }

  /**
   * Build vertex injection from features.
   */
  private buildVertexInject(features: ShaderFeature[]): string {
    const blocks: string[] = [];
    for (const feature of features) {
      if (feature.vertexInject) {
        blocks.push(feature.vertexInject);
      }
    }
    return blocks.join('\n');
  }

  /**
   * Build fragment texture sampling injection.
   * Uses the 'textured' feature's fragmentInject specifically for this marker.
   */
  private buildFragmentTextureSampling(features: ShaderFeature[]): string {
    const textured = features.find((f) => f.id === 'textured');
    return textured?.fragmentInject ?? '';
  }

  /**
   * Build fragment shadow injection.
   * Uses the 'shadow' feature's fragmentInject specifically.
   */
  private buildFragmentShadow(features: ShaderFeature[]): string {
    const shadow = features.find((f) => f.id === 'shadow');
    return shadow?.fragmentInject ?? '';
  }

  /**
   * Build fragment ambient injection.
   * Uses the 'ibl' feature's fragmentInject if present.
   */
  private buildFragmentAmbient(features: ShaderFeature[]): string {
    const ibl = features.find((f) => f.id === 'ibl');
    return ibl?.fragmentInject ?? '';
  }

  /**
   * Build fragment pre-lighting injection from features.
   * Used for material modifications (wetness, etc.) that must happen before PBR.
   */
  private buildFragmentPreLighting(features: ShaderFeature[]): string {
    const blocks: string[] = [];
    for (const feature of features) {
      if (feature.fragmentPreLightingInject) {
        blocks.push(feature.fragmentPreLightingInject);
      }
    }
    return blocks.join('\n');
  }

  /**
   * Build fragment post-processing injection from features.
   */
  private buildFragmentPost(features: ShaderFeature[]): string {
    const blocks: string[] = [];
    for (const feature of features) {
      if (feature.fragmentPostInject) {
        blocks.push(feature.fragmentPostInject);
      }
    }
    return blocks.join('\n');
  }
}