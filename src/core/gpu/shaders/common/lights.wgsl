// ============ Multi-Light Data Structures ============
// Used by the multi-light shader feature for point and spot lights.
// These structs must match the GPU buffer layout in LightBufferManager.

struct PointLightData {
  position: vec3f,
  range: f32,
  color: vec3f,
  intensity: f32,
};

struct SpotLightData {
  position: vec3f,
  range: f32,
  direction: vec3f,
  intensity: f32,
  color: vec3f,
  innerCos: f32,       // cos(innerConeAngle)
  outerCos: f32,       // cos(outerConeAngle)
  shadowAtlasIndex: i32, // -1 = no shadow, 0+ = atlas layer index
  cookieAtlasIndex: i32, // -1 = no cookie, 0+ = cookie atlas layer index
  cookieIntensity: f32,
  // Light-space matrix for spot shadow projection (4x4 = 16 floats)
  lightSpaceMatrix: mat4x4f,
};

struct LightCounts {
  numPoint: u32,
  numSpot: u32,
  _pad0: u32,
  _pad1: u32,
};

// ============ Attenuation Functions ============

/**
 * Smooth distance attenuation with range falloff.
 * Returns 1.0 at distance=0, 0.0 at distance>=range.
 * Uses inverse-square law with a smooth windowing function.
 */
fn attenuateDistance(distance: f32, range: f32) -> f32 {
  if (range <= 0.0) { return 0.0; }
  let ratio = distance / range;
  if (ratio >= 1.0) { return 0.0; }
  // Smooth window: (1 - (d/r)^2)^2 * 1/(d^2 + epsilon)
  let window = pow(saturate(1.0 - ratio * ratio), 2.0);
  let invDist2 = 1.0 / (distance * distance + 0.01);
  return window * invDist2;
}

/**
 * Spot light cone falloff.
 * Smooth transition between inner and outer cone angles.
 */
fn attenuateSpotCone(cosAngle: f32, innerCos: f32, outerCos: f32) -> f32 {
  return saturate((cosAngle - outerCos) / max(innerCos - outerCos, 0.001));
}