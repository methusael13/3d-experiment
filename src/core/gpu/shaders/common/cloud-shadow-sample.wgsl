/**
 * cloud-shadow-sample.wgsl — Shared cloud shadow sampling for scene shaders
 *
 * Provides functions to sample the cloud shadow map and apply cloud shadows
 * to terrain, objects, and water. Also provides CSM shadow fade under overcast.
 *
 * Expected bindings at @group(3):
 *   @binding(17) var env_cloudShadowMap: texture_2d<f32>;
 *   @binding(18) var<uniform> env_cloudShadowUniforms: CloudShadowSceneUniforms;
 *
 * The cloud shadow sampler reuses env_cubeSampler (@binding(5)) which is a filtering sampler.
 */

struct CloudShadowSceneUniforms {
  shadowCenter: vec2f,      // World XZ center of shadow map
  shadowRadius: f32,        // Half-extent in world units
  averageCoverage: f32,     // 0 = clear, 1 = overcast (for lighting adaptation)
}

/**
 * Sample cloud shadow at a world position.
 * Returns transmittance: 1.0 = fully lit, 0.0 = fully shadowed by clouds.
 */
fn sampleCloudShadow(
  cloudShadowMap: texture_2d<f32>,
  cloudShadowSampler: sampler,
  cloudShadowUniforms: CloudShadowSceneUniforms,
  worldPos: vec3f
) -> f32 {
  // Convert world XZ to shadow map UV
  let offset = vec2f(worldPos.x, worldPos.z) - cloudShadowUniforms.shadowCenter;
  let uv = offset / (cloudShadowUniforms.shadowRadius * 2.0) + 0.5;

  // Out of bounds check — no shadow outside the map
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return 1.0;
  }

  // Sample transmittance from R channel
  let transmittance = textureSampleLevel(cloudShadowMap, cloudShadowSampler, uv, 0.0).r;
  return transmittance;
}

/**
 * Compute shadow visibility factor that fades CSM shadows under overcast.
 * Under heavy cloud cover, directional shadows should fade out because
 * the sun is fully diffused by the cloud layer.
 *
 * Returns: 1.0 = full shadows visible, 0.0 = no shadows (overcast)
 */
fn getOvercastShadowFade(averageCoverage: f32) -> f32 {
  // Coverage < 60%: Full shadows (clear/partly cloudy)
  // Coverage 60–90%: Shadows fade out (transition to overcast)
  // Coverage > 90%: No visible shadows (fully overcast / rainy)
  return 1.0 - smoothstep(0.6, 0.9, averageCoverage);
}
