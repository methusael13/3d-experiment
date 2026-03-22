/**
 * Material Preview Shader
 * 
 * Renders a PBR-lit sphere/cube/plane for the material editor Preview node.
 * Self-contained shader with procedural sphere geometry, full PBR lighting
 * (single directional light + hemisphere ambient), and texture sampling.
 *
 * Bind group layout:
 *   @group(0) @binding(0) : MaterialUniforms (uniform buffer)
 *   @group(0) @binding(1) : sampler
 *   @group(0) @binding(2) : baseColor texture
 *   @group(0) @binding(3) : normal texture
 *   @group(0) @binding(4) : metallicRoughness texture (G=rough, B=metal)
 *   @group(0) @binding(5) : occlusion texture
 *   @group(0) @binding(6) : emissive texture
 */

// ==================== Constants ====================

const PI = 3.14159265359;
const EPSILON = 0.0001;

// ==================== Uniforms ====================

struct MaterialUniforms {
  // vec4(albedo.rgb, metallic)
  albedoMetallic: vec4f,
  // vec4(roughness, normalScale, occlusionStrength, alphaCutoff)
  roughnessParams: vec4f,
  // vec4(emissive.rgb, ior)
  emissiveIOR: vec4f,
  // vec4(clearcoatFactor, clearcoatRoughness, hasBaseColorTex, hasNormalTex)
  clearcoatTexFlags1: vec4f,
  // vec4(hasMRTex, hasOcclusionTex, hasEmissiveTex, shapeType) — 0=sphere, 1=cube, 2=plane
  texFlags2Shape: vec4f,
}

@group(0) @binding(0) var<uniform> material: MaterialUniforms;
@group(0) @binding(1) var texSampler: sampler;
@group(0) @binding(2) var baseColorTex: texture_2d<f32>;
@group(0) @binding(3) var normalTex: texture_2d<f32>;
@group(0) @binding(4) var metallicRoughnessTex: texture_2d<f32>;
@group(0) @binding(5) var occlusionTex: texture_2d<f32>;
@group(0) @binding(6) var emissiveTex: texture_2d<f32>;

// ==================== Vertex ====================

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) worldNormal: vec3f,
  @location(2) uv: vec2f,
  @location(3) worldTangent: vec3f,
  @location(4) bitangentSign: f32,
}

// Procedural UV sphere with 32x32 segments = 2048 triangles = 6144 vertices
// Using vertex_index to generate sphere geometry procedurally
const SEGMENTS_U: u32 = 32u;
const SEGMENTS_V: u32 = 32u;
const TOTAL_VERTICES: u32 = SEGMENTS_U * SEGMENTS_V * 6u;

fn sphereVertex(vertexIndex: u32) -> VertexOutput {
  // Each quad is 2 triangles = 6 vertices
  let quadIndex = vertexIndex / 6u;
  let vertInQuad = vertexIndex % 6u;
  
  let quadU = quadIndex % SEGMENTS_U;
  let quadV = quadIndex / SEGMENTS_U;
  
  // Local vertex offsets for two triangles of a quad
  var du: u32;
  var dv: u32;
  switch(vertInQuad) {
    case 0u: { du = 0u; dv = 0u; }
    case 1u: { du = 1u; dv = 0u; }
    case 2u: { du = 1u; dv = 1u; }
    case 3u: { du = 0u; dv = 0u; }
    case 4u: { du = 1u; dv = 1u; }
    case 5u: { du = 0u; dv = 1u; }
    default: { du = 0u; dv = 0u; }
  }
  
  let u = f32(quadU + du) / f32(SEGMENTS_U);
  let v = f32(quadV + dv) / f32(SEGMENTS_V);
  
  let theta = u * 2.0 * PI; // longitude
  let phi = v * PI;          // latitude (0=top, PI=bottom)
  
  let sinPhi = sin(phi);
  let cosPhi = cos(phi);
  let sinTheta = sin(theta);
  let cosTheta = cos(theta);
  
  let pos = vec3f(sinPhi * cosTheta, cosPhi, sinPhi * sinTheta);
  let normal = normalize(pos);
  
  // Tangent: derivative of position w.r.t. u (theta)
  let tangent = normalize(vec3f(-sinPhi * sinTheta, 0.0, sinPhi * cosTheta));
  
  // Camera: fixed orbital at 45° elevation, 3.0 distance
  let camDist = 3.0;
  let camElev = 0.4; // radians
  let camPos = vec3f(
    camDist * cos(camElev) * sin(0.0),
    camDist * sin(camElev),
    camDist * cos(camElev) * cos(0.0)
  );
  
  // View matrix (look-at)
  let lookAtPoint = vec3f(0.0, 0.0, 0.0);
  let forward = normalize(lookAtPoint - camPos);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  
  let viewPos = vec3f(
    dot(pos - camPos, right),
    dot(pos - camPos, up),
    dot(pos - camPos, -forward)
  );
  
  // Perspective projection
  let fov = 0.8; // radians (~46°)
  let aspect = 1.0;
  let near = 0.1;
  let far = 10.0;
  let f = 1.0 / tan(fov * 0.5);
  
  let clipPos = vec4f(
    viewPos.x * f / aspect,
    viewPos.y * f,
    (viewPos.z * (far + near) / (near - far)) + (2.0 * far * near / (near - far)),
    -viewPos.z
  );
  
  var output: VertexOutput;
  output.position = clipPos;
  output.worldPos = pos;
  output.worldNormal = normal;
  output.uv = vec2f(u, v);
  output.worldTangent = tangent;
  output.bitangentSign = 1.0;
  return output;
}

fn cubeVertex(vertexIndex: u32) -> VertexOutput {
  // 6 faces × 2 triangles × 3 vertices = 36 vertices
  // Face vertices with positions, normals, and UVs
  var positions = array<vec3f, 36>(
    // +Z face
    vec3f(-1, -1,  1), vec3f( 1, -1,  1), vec3f( 1,  1,  1),
    vec3f(-1, -1,  1), vec3f( 1,  1,  1), vec3f(-1,  1,  1),
    // -Z face
    vec3f( 1, -1, -1), vec3f(-1, -1, -1), vec3f(-1,  1, -1),
    vec3f( 1, -1, -1), vec3f(-1,  1, -1), vec3f( 1,  1, -1),
    // +X face
    vec3f( 1, -1,  1), vec3f( 1, -1, -1), vec3f( 1,  1, -1),
    vec3f( 1, -1,  1), vec3f( 1,  1, -1), vec3f( 1,  1,  1),
    // -X face
    vec3f(-1, -1, -1), vec3f(-1, -1,  1), vec3f(-1,  1,  1),
    vec3f(-1, -1, -1), vec3f(-1,  1,  1), vec3f(-1,  1, -1),
    // +Y face
    vec3f(-1,  1,  1), vec3f( 1,  1,  1), vec3f( 1,  1, -1),
    vec3f(-1,  1,  1), vec3f( 1,  1, -1), vec3f(-1,  1, -1),
    // -Y face
    vec3f(-1, -1, -1), vec3f( 1, -1, -1), vec3f( 1, -1,  1),
    vec3f(-1, -1, -1), vec3f( 1, -1,  1), vec3f(-1, -1,  1),
  );
  
  var normals = array<vec3f, 6>(
    vec3f(0, 0, 1), vec3f(0, 0, -1),
    vec3f(1, 0, 0), vec3f(-1, 0, 0),
    vec3f(0, 1, 0), vec3f(0, -1, 0),
  );
  
  var uvs = array<vec2f, 6>(
    vec2f(0, 1), vec2f(1, 1), vec2f(1, 0),
    vec2f(0, 1), vec2f(1, 0), vec2f(0, 0),
  );
  
  let idx = min(vertexIndex, 35u);
  let faceIdx = idx / 6u;
  let vertIdx = idx % 6u;
  
  let pos = positions[idx] * 0.65; // Scale down to fit view
  let normal = normals[faceIdx];
  let uv = uvs[vertIdx];
  
  // Tangent for cube faces
  var tangent: vec3f;
  if (faceIdx == 0u || faceIdx == 1u) { tangent = vec3f(1, 0, 0); }
  else if (faceIdx == 2u || faceIdx == 3u) { tangent = vec3f(0, 0, 1); }
  else { tangent = vec3f(1, 0, 0); }
  
  // Camera setup (same as sphere)
  let camDist = 3.0;
  let camElev = 0.4;
  let camPos = vec3f(0.0, camDist * sin(camElev), camDist * cos(camElev));
  let lookAtPoint = vec3f(0.0, 0.0, 0.0);
  let forward = normalize(lookAtPoint - camPos);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  
  let viewPos = vec3f(
    dot(pos - camPos, right),
    dot(pos - camPos, up),
    dot(pos - camPos, -forward)
  );
  
  let fov = 0.8;
  let f = 1.0 / tan(fov * 0.5);
  let near = 0.1;
  let far = 10.0;
  
  let clipPos = vec4f(
    viewPos.x * f,
    viewPos.y * f,
    (viewPos.z * (far + near) / (near - far)) + (2.0 * far * near / (near - far)),
    -viewPos.z
  );
  
  var output: VertexOutput;
  output.position = clipPos;
  output.worldPos = pos;
  output.worldNormal = normal;
  output.uv = uv;
  output.worldTangent = tangent;
  output.bitangentSign = 1.0;
  return output;
}

fn planeVertex(vertexIndex: u32) -> VertexOutput {
  // Simple plane: 2 triangles = 6 vertices
  var positions = array<vec3f, 6>(
    vec3f(-1, 0, -1), vec3f( 1, 0, -1), vec3f( 1, 0,  1),
    vec3f(-1, 0, -1), vec3f( 1, 0,  1), vec3f(-1, 0,  1),
  );
  var planeUVs = array<vec2f, 6>(
    vec2f(0, 0), vec2f(1, 0), vec2f(1, 1),
    vec2f(0, 0), vec2f(1, 1), vec2f(0, 1),
  );
  
  let idx = min(vertexIndex, 5u);
  let pos = positions[idx] * 1.0;
  let normal = vec3f(0.0, 1.0, 0.0);
  let uv = planeUVs[idx];
  
  // Camera: looking down at 60° angle
  let camDist = 2.5;
  let camElev = 0.9; // ~52°
  let camPos = vec3f(0.0, camDist * sin(camElev), camDist * cos(camElev));
  let lookAtPoint = vec3f(0.0, 0.0, 0.0);
  let forward = normalize(lookAtPoint - camPos);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  
  let viewPos = vec3f(
    dot(pos - camPos, right),
    dot(pos - camPos, up),
    dot(pos - camPos, -forward)
  );
  
  let fov = 0.8;
  let f = 1.0 / tan(fov * 0.5);
  let near = 0.1;
  let far = 10.0;
  
  let clipPos = vec4f(
    viewPos.x * f,
    viewPos.y * f,
    (viewPos.z * (far + near) / (near - far)) + (2.0 * far * near / (near - far)),
    -viewPos.z
  );
  
  var output: VertexOutput;
  output.position = clipPos;
  output.worldPos = pos;
  output.worldNormal = normal;
  output.uv = uv;
  output.worldTangent = vec3f(1.0, 0.0, 0.0);
  output.bitangentSign = 1.0;
  return output;
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  let shapeType = u32(material.texFlags2Shape.w);
  
  if (shapeType == 1u) {
    return cubeVertex(vertexIndex);
  } else if (shapeType == 2u) {
    return planeVertex(vertexIndex);
  }
  return sphereVertex(vertexIndex);
}

// ==================== PBR Functions ====================

fn fresnelSchlick(cosTheta: f32, F0: vec3f) -> vec3f {
  return F0 + (vec3f(1.0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
}

fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3f, roughness: f32) -> vec3f {
  return F0 + (max(vec3f(1.0 - roughness), F0) - F0) * pow(saturate(1.0 - cosTheta), 5.0);
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
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

// ==================== Fragment ====================

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  let uv = input.uv;
  
  // --- Resolve PBR parameters from uniforms + textures ---
  
  var albedo = material.albedoMetallic.rgb;
  var metallic = material.albedoMetallic.w;
  var roughness = material.roughnessParams.x;
  let normalScale = material.roughnessParams.y;
  let occlusionStrength = material.roughnessParams.z;
  let emissiveFactor = material.emissiveIOR.rgb;
  
  // Sample baseColor texture if connected
  if (material.clearcoatTexFlags1.z > 0.5) {
    let texColor = textureSample(baseColorTex, texSampler, uv);
    // sRGB to linear approximation
    albedo *= pow(texColor.rgb, vec3f(2.2));
  }
  
  // Sample metallicRoughness texture if connected
  if (material.texFlags2Shape.x > 0.5) {
    let mrSample = textureSample(metallicRoughnessTex, texSampler, uv);
    roughness *= mrSample.g;
    metallic *= mrSample.b;
  }
  
  // Sample occlusion texture if connected
  var ao = 1.0;
  if (material.texFlags2Shape.y > 0.5) {
    let aoSample = textureSample(occlusionTex, texSampler, uv);
    ao = mix(1.0, aoSample.r, occlusionStrength);
  }
  
  // Sample emissive texture if connected
  var emissive = emissiveFactor;
  if (material.texFlags2Shape.z > 0.5) {
    let emSample = textureSample(emissiveTex, texSampler, uv);
    emissive *= pow(emSample.rgb, vec3f(2.2));
  }
  
  // Clamp roughness
  roughness = clamp(roughness, 0.04, 1.0);
  
  // --- Normal mapping ---
  var N = normalize(input.worldNormal);
  
  if (material.clearcoatTexFlags1.w > 0.5) {
    let T = normalize(input.worldTangent);
    let B = cross(N, T) * input.bitangentSign;
    let TBN = mat3x3f(T, B, N);
    
    let normalSample = textureSample(normalTex, texSampler, uv).rgb;
    var tangentNormal = normalSample * 2.0 - 1.0;
    tangentNormal = vec3f(tangentNormal.xy * normalScale, tangentNormal.z);
    N = normalize(TBN * tangentNormal);
  }
  
  // --- Camera and Light setup ---
  
  // Camera position (matches vertex shader)
  let camDist = 3.0;
  let camElev = 0.4;
  let shapeType = u32(material.texFlags2Shape.w);
  var camPos: vec3f;
  if (shapeType == 2u) {
    let pe = 0.9;
    camPos = vec3f(0.0, camDist * sin(pe), camDist * cos(pe));
  } else {
    camPos = vec3f(0.0, camDist * sin(camElev), camDist * cos(camElev));
  }
  
  let V = normalize(camPos - input.worldPos);
  
  // Key light: warm directional from upper-right
  let L1 = normalize(vec3f(0.8, 1.0, 0.6));
  let lightColor1 = vec3f(1.0, 0.95, 0.9) * 4.0;
  
  // Fill light: cool directional from lower-left  
  let L2 = normalize(vec3f(-0.5, 0.3, -0.8));
  let lightColor2 = vec3f(0.3, 0.4, 0.6) * 1.5;
  
  // --- F0 from IOR (dielectric) blended with albedo (metallic) ---
  let ior = material.emissiveIOR.w;
  let iorF0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let dielectricF0 = vec3f(iorF0);
  let F0 = mix(dielectricF0, albedo, metallic);
  let NdotV_global = max(dot(N, V), EPSILON);
  
  // Light 1 (key)
  var color = vec3f(0.0);
  {
    let H = normalize(V + L1);
    let NdotL = max(dot(N, L1), 0.0);
    let NdotV = max(dot(N, V), EPSILON);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);
    
    if (NdotL > 0.0) {
      let D = distributionGGX(NdotH, roughness);
      let G = geometrySmith(NdotV, NdotL, roughness);
      let F = fresnelSchlick(VdotH, F0);
      
      let specular = (D * G * F) / (4.0 * NdotV * NdotL + EPSILON);
      let kS = F;
      let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
      let diffuse = kD * albedo / PI;
      
      color += (diffuse + specular) * lightColor1 * NdotL;
    }
  }
  
  // Light 2 (fill)
  {
    let H = normalize(V + L2);
    let NdotL = max(dot(N, L2), 0.0);
    let NdotV = max(dot(N, V), EPSILON);
    let NdotH = max(dot(N, H), 0.0);
    let VdotH = max(dot(V, H), 0.0);
    
    if (NdotL > 0.0) {
      let D = distributionGGX(NdotH, roughness);
      let G = geometrySmith(NdotV, NdotL, roughness);
      let F = fresnelSchlick(VdotH, F0);
      
      let specular = (D * G * F) / (4.0 * NdotV * NdotL + EPSILON);
      let kS = F;
      let kD = (vec3f(1.0) - kS) * (1.0 - metallic);
      let diffuse = kD * albedo / PI;
      
      color += (diffuse + specular) * lightColor2 * NdotL;
    }
  }
  
  // --- Image-Based Lighting (Split-Sum Approximation) ---
  // Without an actual IBL cubemap, we approximate with analytical sky/ground colors.
  {
    // Hemisphere irradiance for diffuse (Lambert)
    let skyIrradiance = vec3f(0.4, 0.5, 0.7);
    let groundIrradiance = vec3f(0.15, 0.12, 0.1);
    let irradiance = mix(groundIrradiance, skyIrradiance, N.y * 0.5 + 0.5);
    
    // Roughness-aware Fresnel for IBL specular
    let F_ibl = fresnelSchlickRoughness(NdotV_global, F0, roughness);
    let kS_ibl = F_ibl;
    let kD_ibl = (vec3f(1.0) - kS_ibl) * (1.0 - metallic);
    
    // Diffuse IBL
    let iblDiffuse = kD_ibl * albedo * irradiance;
    
    // Specular IBL — split-sum approximation without LUT
    // Approximate the BRDF integration (Karis 2014 analytical fit)
    let a = roughness;
    let envBRDF_x = max(0.0, 1.0 - a) * pow(1.0 - NdotV_global, 5.0 * exp(-2.69 * a));
    let envBRDF_y = 1.0 - envBRDF_x;
    let envBRDF = vec2f(envBRDF_y, envBRDF_x);
    
    // Approximate prefiltered environment color from hemisphere
    // Rough surfaces see more diffuse, smooth surfaces see sharp reflections
    let R = reflect(-V, N);
    let specSkyColor = vec3f(0.5, 0.6, 0.8);
    let specGroundColor = vec3f(0.15, 0.12, 0.1);
    let prefilteredColor = mix(
      mix(specGroundColor, specSkyColor, R.y * 0.5 + 0.5),
      irradiance,
      roughness * roughness
    );
    
    let iblSpecular = prefilteredColor * (F0 * envBRDF.x + envBRDF.y);
    
    // Combine IBL with AO
    let iblAmbient = (iblDiffuse + iblSpecular) * ao * 0.6;
    color += iblAmbient;
  }
  
  // --- Emissive ---
  color += emissive;
  
  // --- Clearcoat (applied over both key + fill lights) ---
  let clearcoat = material.clearcoatTexFlags1.x;
  if (clearcoat > 0.001) {
    let ccRoughness = max(material.clearcoatTexFlags1.y, 0.04);
    let ccF0 = vec3f(0.04);
    
    // Key light clearcoat
    {
      let H1 = normalize(V + L1);
      let NdotH1 = max(dot(N, H1), 0.0);
      let NdotL1 = max(dot(N, L1), 0.0);
      let VdotH1 = max(dot(V, H1), 0.0);
      
      let ccD1 = distributionGGX(NdotH1, ccRoughness);
      let ccG1 = geometrySmith(NdotV_global, NdotL1, ccRoughness);
      let ccF1 = fresnelSchlick(VdotH1, ccF0);
      let ccSpec1 = (ccD1 * ccG1 * ccF1) / (4.0 * NdotV_global * NdotL1 + EPSILON);
      
      color += ccSpec1 * lightColor1 * NdotL1 * clearcoat;
    }
    
    // Fill light clearcoat
    {
      let H2 = normalize(V + L2);
      let NdotH2 = max(dot(N, H2), 0.0);
      let NdotL2 = max(dot(N, L2), 0.0);
      let VdotH2 = max(dot(V, H2), 0.0);
      
      let ccD2 = distributionGGX(NdotH2, ccRoughness);
      let ccG2 = geometrySmith(NdotV_global, NdotL2, ccRoughness);
      let ccF2 = fresnelSchlick(VdotH2, ccF0);
      let ccSpec2 = (ccD2 * ccG2 * ccF2) / (4.0 * NdotV_global * NdotL2 + EPSILON);
      
      color += ccSpec2 * lightColor2 * NdotL2 * clearcoat;
    }
    
    // Clearcoat IBL specular (smooth coat reflection)
    {
      let ccF_ibl = fresnelSchlickRoughness(NdotV_global, ccF0, ccRoughness);
      let R = reflect(-V, N);
      let ccSkyColor = vec3f(0.5, 0.6, 0.8);
      let ccEnvColor = mix(vec3f(0.12), ccSkyColor, R.y * 0.5 + 0.5);
      color += ccEnvColor * ccF_ibl * clearcoat * 0.3;
    }
  }
  
  // --- Tone mapping (simple Reinhard) ---
  color = color / (color + vec3f(1.0));
  
  // --- Gamma correction ---
  color = pow(color, vec3f(1.0 / 2.2));
  
  // Dark background gradient for the preview sphere
  return vec4f(color, 1.0);
}
