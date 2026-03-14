/**
 * Skinning Shader Feature — vertex skinning for skeletal animation.
 *
 * Integrates with the shader composition system. When composed, this feature:
 * 1. Declares a `boneMatrices` storage buffer in Group 2 (textures)
 * 2. Adds `jointIndices` and `jointWeights` vertex attributes (@location 5, 6)
 * 3. Injects skinning computation in the vertex shader before model matrix transform
 *
 * The bone matrix storage buffer is placed in Group 2 (textures), NOT Group 1 (perObject),
 * because Group 1 has a fixed layout (model matrix + material uniforms) shared by ALL mesh
 * variants. Group 2 is built dynamically by VariantMeshPool.buildTextureBindGroup() using
 * canonical name lookup, so the bone buffer fits naturally alongside PBR textures.
 *
 * This feature is only composed for entities that have SkeletonComponent — non-skinned
 * shaders never include this code (no #ifdef needed).
 */

import type { ShaderFeature } from '../composition/types';

export const skinningFeature: ShaderFeature = {
  id: 'skinning',
  stage: 'vertex',

  resources: [
    {
      name: 'boneMatrices',
      kind: 'storage',
      group: 'textures',
      provider: 'skeleton',
    },
  ],

  varyings: '', // No extra varyings — skinning transforms positions/normals before model matrix

  functions: `
// ── Skeletal Skinning ──
// boneMatrices is bound as a read-only storage buffer in Group 2
// @group(2) @binding(N) var<storage, read> boneMatrices: array<mat4x4f>;

fn computeSkinMatrix(joints: vec4u, weights: vec4f) -> mat4x4f {
  return boneMatrices[joints.x] * weights.x
       + boneMatrices[joints.y] * weights.y
       + boneMatrices[joints.z] * weights.z
       + boneMatrices[joints.w] * weights.w;
}

fn applySkinning(pos: vec3f, nrm: vec3f, joints: vec4u, weights: vec4f) -> array<vec3f, 2> {
  let skinMat = computeSkinMatrix(joints, weights);
  let skinnedPos = (skinMat * vec4f(pos, 1.0)).xyz;
  let skinnedNrm = normalize((skinMat * vec4f(nrm, 0.0)).xyz);
  return array<vec3f, 2>(skinnedPos, skinnedNrm);
}
`,

  // Vertex inputs injected into VertexInput struct via EXTRA_VERTEX_INPUTS marker
  vertexInputs: `
  @location(5) jointIndices: vec4u,
  @location(6) jointWeights: vec4f,`,

  // Injected into vertex main body before model matrix transform
  vertexInject: `
  // Apply skeletal skinning before model matrix transform
  {
    let skinResult = applySkinning(localPos, input.normal, input.jointIndices, input.jointWeights);
    localPos = skinResult[0];
    skinnedNormal = skinResult[1];
  }
`,
};
