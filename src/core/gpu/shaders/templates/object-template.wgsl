// Object PBR Template — base shader with injection markers for shader composition.
//
// Injection markers (replaced by ShaderComposer):
//   EXTRA_UNIFORM_FIELDS  — additional per-object uniform fields
//   EXTRA_BINDINGS        — additional texture/sampler declarations
//   EXTRA_VARYINGS        — additional VertexOutput fields
//   FUNCTIONS             — feature function definitions
//   VERTEX_FEATURES       — vertex main body injection (after world transform)
//   FRAGMENT_AMBIENT      — ambient lighting injection (IBL vs hemisphere)
//   FRAGMENT_POST         — post-color injection (snow, dissolve, etc.)
//
// Bind Group Layout:
//   Group 0: Global uniforms (camera, light, shadow flags)
//   Group 1: Per-mesh uniforms (model matrix, material)
//   Group 2: PBR textures + feature textures (composed)
//   Group 3: Environment (shadow map + IBL cubemaps + CSM)

// ============ Constants ============

const PI = 3.14159265359;
const EPSILON = 0.0001;

// ============ Global Uniforms (Group 0) ============

struct GlobalUniforms {
  viewProjection: mat4x4f,
  cameraPosition: vec3f,
  _pad0: f32,
  lightDirection: vec3f,
  _pad1: f32,
  lightColor: vec3f,
  ambientIntensity: f32,
  lightSpaceMatrix: mat4x4f,
  shadowEnabled: f32,
  shadowBias: f32,
  csmEnabled: f32,
  _pad3: f32,
}

@group(0) @binding(0) var<uniform> globals: GlobalUniforms;

// ============ Per-Object Uniforms (Group 1) ============

struct SingleModelUniforms {
  model: mat4x4f,
}

struct MaterialUniforms {
  albedo: vec3f,
  metallic: f32,

  roughness: f32,
  normalScale: f32,
  occlusionStrength: f32,
  alphaCutoff: f32,

  emissiveFactor: vec3f,
  useAlphaCutoff: f32,

  textureFlags: vec4f,

  ior: f32,                  // Index of refraction (default 1.5); negative = unlit
  clearcoatFactor: f32,      // KHR_materials_clearcoat factor [0-1]
  clearcoatRoughness: f32,   // KHR_materials_clearcoat roughness [0-1]
  hasEmissiveTex: f32,       // 1.0 if emissive texture is present

  /*{{EXTRA_UNIFORM_FIELDS}}*/
}

@group(1) @binding(0) var<uniform> singleModel: SingleModelUniforms;
@group(1) @binding(1) var<uniform> material: MaterialUniforms;

// ============ Textures (Group 2) — Composed ============

/*{{EXTRA_BINDINGS}}*/

// ============ Environment (Group 3) ============
// Shadow + IBL + CSM — bound by the pipeline, not composed per-entity

/*{{ENVIRONMENT_BINDINGS}}*/

// ============ Vertex I/O ============

struct VertexInput {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4f,
  @location(0) worldPosition: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) uv: vec2f,
  @location(3) lightSpacePos: vec4f,
  /*{{EXTRA_VARYINGS}}*/
}

// ============ Feature Function Definitions ============

/*{{FUNCTIONS}}*/

// ============ PBR Core Functions ============

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let NdotH2 = NdotH * NdotH;
  let denom = NdotH2 * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom + EPSILON);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k + EPSILON);
}

fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let ggx1 = geometrySchlickGGX(NdotV, roughness);
  let ggx2 = geometrySchlickGGX(NdotL, roughness);
  return ggx1 * ggx2;
}

fn pbrDirectional(
  N: vec3f,
  V: vec3f,
  L: vec3f,
  albedo: vec3f,
  metallic: f32,
  roughness: f32,
  lightColor: vec3f
) -> vec3f {
  let H = normalize(V + L);

  let NdotL = max(dot(N, L), 0.0);
  let NdotV = max(dot(N, V), EPSILON);
  let NdotH = max(dot(N, H), 0.0);
  let VdotH = max(dot(V, H), 0.0);

  if (NdotL <= 0.0) {
    return vec3f(0.0);
  }

  let clampedRoughness = clamp(roughness, 0.04, 1.0);

  // F0 from IOR: F0 = ((ior - 1) / (ior + 1))^2
  // For dielectrics, uses IOR-derived F0 instead of hardcoded 0.04
  // For metals, uses albedo as F0 (per metallic workflow)
  let iorVal = max(material.ior, 1.0);
  let iorF0 = pow((iorVal - 1.0) / (iorVal + 1.0), 2.0);
  let F0 = mix(vec3f(iorF0), albedo, metallic);

  let D = distributionGGX(NdotH, clampedRoughness);
  let G = geometrySmith(NdotV, NdotL, clampedRoughness);
  let F = fresnelSchlick(VdotH, F0);

  let numerator = D * G * F;
  let denominator = 4.0 * NdotV * NdotL + EPSILON;
  let specular = numerator / denominator;

  let kS = F;
  let kD = (vec3f(1.0) - kS) * (1.0 - metallic);

  let diffuse = kD * albedo / PI;

  return (diffuse + specular) * lightColor * NdotL;
}

fn hemisphereAmbient(N: vec3f, albedo: vec3f, ambient: f32) -> vec3f {
  let skyColor = vec3f(0.5, 0.7, 1.0);
  let groundColor = vec3f(0.3, 0.25, 0.2);
  let hemisphereColor = mix(groundColor, skyColor, N.y * 0.5 + 0.5);
  return albedo * hemisphereColor * ambient;
}

fn srgbToLinear(srgb: vec3f) -> vec3f {
  let low = srgb / 12.92;
  let high = pow((srgb + 0.055) / 1.055, vec3f(2.4));
  return vec3f(
    select(high.x, low.x, srgb.x < 0.04045),
    select(high.y, low.y, srgb.y < 0.04045),
    select(high.z, low.z, srgb.z < 0.04045)
  );
}

fn cotangentFrame(N: vec3f, p: vec3f, uv: vec2f) -> mat3x3f {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);

  let dp2perp = cross(dp2, N);
  let dp1perp = cross(N, dp1);

  let T = dp2perp * duv1.x + dp1perp * duv2.x;
  let B = dp2perp * duv1.y + dp1perp * duv2.y;

  let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
  return mat3x3f(T * invmax, B * invmax, N);
}

// ============ Vertex Shader ============

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Local position — features may modify this before world transform
  var localPos = input.position;

  /*{{VERTEX_FEATURES}}*/

  // Transform position to world space
  let worldPos = singleModel.model * vec4f(localPos, 1.0);
  output.worldPosition = worldPos.xyz;

  // Transform to clip space
  output.clipPosition = globals.viewProjection * worldPos;

  // Transform normal to world space (assuming uniform scale)
  let normalMatrix = mat3x3f(
    singleModel.model[0].xyz,
    singleModel.model[1].xyz,
    singleModel.model[2].xyz
  );
  output.worldNormal = normalize(normalMatrix * input.normal);

  output.uv = input.uv;

  // Transform to light space for shadow mapping
  output.lightSpacePos = globals.lightSpaceMatrix * vec4f(output.worldPosition, 1.0);

  return output;
}

// ============ Fragment Output (MRT) ============

struct FragmentOutput {
  @location(0) color: vec4f,           // HDR scene color
  @location(1) normals: vec4f,         // World-space normal packed [0,1] + metallic in .w
}

// ============ Fragment Shader ============

@fragment
fn fs_main(input: VertexOutput) -> FragmentOutput {
  var output: FragmentOutput;
  // ---- Material setup ----
  let hasBaseColorTex = material.textureFlags.x > 0.5;
  let hasNormalTex = material.textureFlags.y > 0.5;
  let hasMetallicRoughnessTex = material.textureFlags.z > 0.5;
  let hasOcclusionTex = material.textureFlags.w > 0.5;

  var albedo = material.albedo;
  var alpha = 1.0;
  var metallic = material.metallic;
  var roughness = material.roughness;
  var N = normalize(input.worldNormal);
  var ao = 1.0;
  var emissive = material.emissiveFactor;

  // ---- Texture sampling (injected by textured feature or inlined as no-ops) ----
  /*{{FRAGMENT_TEXTURE_SAMPLING}}*/

  // ---- Pre-lighting material modifications (wetness, etc.) ----
  /*{{FRAGMENT_PRE_LIGHTING}}*/

  // ---- Unlit check: negative IOR signals KHR_materials_unlit ----
  let isUnlit = material.ior < 0.0;

  // ---- Lighting ----
  let V = normalize(globals.cameraPosition - input.worldPosition);
  let L = normalize(globals.lightDirection);

  // Shadow (injected by shadow feature; defaults to 1.0 if not present)
  var shadow = 1.0;
  /*{{FRAGMENT_SHADOW}}*/

  var color: vec3f;

  if (isUnlit) {
    // KHR_materials_unlit: output albedo directly, no PBR lighting
    color = albedo + emissive;
  } else {
    // Direct lighting
    let direct = pbrDirectional(N, V, L, albedo, metallic, roughness, globals.lightColor) * shadow;

    // Ambient lighting (IBL or hemisphere — injected by feature)
    var ambient = hemisphereAmbient(N, albedo, globals.ambientIntensity) * ao;
    /*{{FRAGMENT_AMBIENT}}*/

    // Base PBR color
    color = direct + ambient + emissive;

    // ---- Clearcoat layer (KHR_materials_clearcoat) ----
    if (material.clearcoatFactor > 0.0) {
      let ccRoughness = clamp(material.clearcoatRoughness, 0.04, 1.0);
      let H = normalize(V + L);
      let NdotL_cc = max(dot(N, L), 0.0);
      let NdotV_cc = max(dot(N, V), EPSILON);
      let NdotH_cc = max(dot(N, H), 0.0);
      let VdotH_cc = max(dot(V, H), 0.0);

      // Clearcoat uses fixed F0=0.04 (polyurethane coating, IOR 1.5)
      let F_cc = fresnelSchlick(VdotH_cc, vec3f(0.04));
      let D_cc = distributionGGX(NdotH_cc, ccRoughness);
      let G_cc = geometrySmith(NdotV_cc, NdotL_cc, ccRoughness);

      let ccSpecular = (D_cc * G_cc * F_cc) / (4.0 * NdotV_cc * NdotL_cc + EPSILON);
      let ccContrib = ccSpecular * globals.lightColor * NdotL_cc * shadow;

      // Blend: clearcoat absorbs some of the base layer energy
      let ccFresnel = fresnelSchlick(NdotV_cc, vec3f(0.04));
      color = color * (1.0 - material.clearcoatFactor * ccFresnel) + ccContrib * material.clearcoatFactor;
    }
  }

  // Post-processing injection (snow, dissolve, etc.)
  /*{{FRAGMENT_POST}}*/

  output.color = vec4f(color, alpha);
  // Pack world-space normal from [-1,1] to [0,1] for G-buffer; metallic in .w
  output.normals = vec4f(N * 0.5 + 0.5, metallic);
  return output;
}
