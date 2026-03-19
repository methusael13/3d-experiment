import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Vegetation Instancing feature — renders vegetation mesh instances via the
 * variant PBR pipeline using GPU-culled instance buffers + drawIndexedIndirect.
 *
 * Vertex stage:
 * - Reads PlantInstance from a storage buffer by instance_index
 * - Applies per-instance Y-axis rotation, scale, and world offset
 * - Applies vegetation-specific fbm2D wind displacement (GPU-computed)
 * - Discards non-mesh instances (renderFlag < 0.5)
 *
 * Fragment stage: no injection — the base PBR pipeline handles lighting.
 *
 * This feature is mutually exclusive with the standard 'wind' feature
 * (vegetation uses GPU-computed wind, not CPU spring simulation).
 *
 * The model matrix for vegetation entities should be set to identity,
 * since the instance buffer provides world-space positioning.
 */
export const vegetationInstancingFeature: ShaderFeature = {
  id: 'vegetation-instancing',
  stage: 'vertex',

  resources: [
    // Instance storage buffer (Group 2 / textures group)
    {
      name: RES.VEG_INSTANCES,
      kind: 'storage',
      group: 'textures',
      provider: 'VegetationInstanceComponent',
    },
    // Per-draw vegetation wind uniforms (Group 1 / perObject)
    {
      name: RES.VEG_WIND_STRENGTH,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_WIND_FREQUENCY,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_WIND_DIR_X,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_WIND_DIR_Z,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_GUST_STRENGTH,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_GUST_FREQUENCY,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_TIME,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_MAX_DISTANCE,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
    {
      name: RES.VEG_WIND_MULTIPLIER,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'VegetationInstanceComponent',
    },
  ],

  // Add @builtin(instance_index) to the VertexInput struct so the vertex shader
  // can index into the vegInstances storage buffer per-instance.
  vertexInputs: `
  @builtin(instance_index) instance_index: u32,`,

  functions: `
// ============ Vegetation Instance Structs & Wind ============

struct VegPlantInstance {
  positionAndScale: vec4f,  // xyz = world pos, w = scale
  rotationAndType: vec4f,   // x = Y rotation, y = variant, z = renderFlag (1=mesh), w = reserved
}

fn vegFbm2D(p: vec2f) -> f32 {
  var value = 0.0;
  var amp = 0.5;
  var pos = p;
  value += amp * (sin(pos.x) * cos(pos.y * 1.3) * 0.5 + 0.5);
  pos *= 2.1;
  amp *= 0.5;
  value += amp * (sin(pos.x * 0.8) * cos(pos.y * 1.1) * 0.5 + 0.5);
  return value;
}

fn applyVegInstanceWind(worldPos: vec3f, vertexHeight: f32, windMult: f32) -> vec3f {
  if (windMult < 0.001 || material.vegWindStrength < 0.001) { return worldPos; }

  let windDir = vec2f(material.vegWindDirX, material.vegWindDirZ);
  let phase = dot(worldPos.xz, windDir) * 0.1 + material.vegTime * material.vegWindFrequency;
  let baseWind = sin(phase) * material.vegWindStrength;

  let gustUV = worldPos.xz * material.vegGustFrequency + material.vegTime * 0.3;
  let gustNoise = vegFbm2D(gustUV) * 2.0 - 1.0;
  let localGust = gustNoise * material.vegGustStrength;

  let displacement = (baseWind + localGust) * vertexHeight * vertexHeight * windMult;

  return worldPos + vec3f(windDir.x, 0.0, windDir.y) * displacement;
}
`,

  vertexInject: `
  // ---- Vegetation Instancing: read instance, apply transform + wind ----
  let vegInst = vegInstances[input.instance_index];

  // Skip non-mesh instances (renderFlag < 0.5 means billboard)
  if (vegInst.rotationAndType.z < 0.5) {
    output.clipPosition = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }

  // Distance cull (skip if beyond maxDistance)
  let vegWorldBase = vegInst.positionAndScale.xyz;
  let vegDistToCamera = distance(vegWorldBase, globals.cameraPosition.xyz);
  if (vegDistToCamera > material.vegMaxDistance) {
    output.clipPosition = vec4f(0.0, 0.0, 0.0, 0.0);
    return output;
  }

  // Apply per-instance Y-axis rotation + uniform scale
  let vegScale = vegInst.positionAndScale.w;
  let vegRot = vegInst.rotationAndType.x;
  let vegCosR = cos(vegRot);
  let vegSinR = sin(vegRot);
  let vegRotatedPos = vec3f(
    localPos.x * vegCosR - localPos.z * vegSinR,
    localPos.y,
    localPos.x * vegSinR + localPos.z * vegCosR
  ) * vegScale;
  skinnedNormal = vec3f(
    skinnedNormal.x * vegCosR - skinnedNormal.z * vegSinR,
    skinnedNormal.y,
    skinnedNormal.x * vegSinR + skinnedNormal.z * vegCosR
  );

  // Compute world position from instance base + rotated/scaled local pos
  // (model matrix is identity for vegetation instances — instance buffer provides world offset)
  var vegWorldPos = vegWorldBase + vegRotatedPos + vec3f(0.0, vegScale * 0.5, 0.0);

  // Apply vegetation wind displacement
  let vegVertexHeight = saturate(vegRotatedPos.y / vegScale * 2.0);
  vegWorldPos = applyVegInstanceWind(vegWorldPos, vegVertexHeight, material.vegWindMultiplier);

  // Override localPos with final world position — model matrix is identity so it passes through
  localPos = vegWorldPos;
`,
};
