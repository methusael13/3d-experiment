// Ocean Finalize (Phase W2)
// Reads displacement fields and analytical slope fields from IFFT output and produces:
//   - Displacement map (rgba16float): xyz = displacement, w = unused
//   - Normal map (rgba16float): xyz = surface normal packed 0-1, w = unused
//
// Normals are computed from analytical frequency-domain slopes (Tessendorf method):
//   ∂h/∂x and ∂h/∂z are computed as i·kx·H(k,t) and i·kz·H(k,t) in the animate
//   shader, IFFT'd to spatial domain, then read here. This avoids finite differences
//   entirely and produces smooth normals that perfectly match the displacement.

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

struct FinalizeParams {
  // vec4: resolution, tileSize, amplitudeScale, texelSize (1/resolution)
  params0: vec4f,
}

@group(0) @binding(0) var inputDy: texture_2d<f32>;
@group(0) @binding(1) var inputDx: texture_2d<f32>;
@group(0) @binding(2) var inputDz: texture_2d<f32>;
@group(0) @binding(3) var outputDisplacement: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var outputNormal: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var<uniform> finalizeParams: FinalizeParams;
@group(0) @binding(6) var inputSlopeX: texture_2d<f32>;
@group(0) @binding(7) var inputSlopeZ: texture_2d<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let resolution = u32(finalizeParams.params0.x);
  if (gid.x >= resolution || gid.y >= resolution) { return; }

  let amplitudeScale = finalizeParams.params0.z;

  // NOTE: No (-1)^(x+y) sign correction here. The centered-FFT sign flip creates a
  // checkerboard of opposite signs in the output texture, which destroys bilinear
  // interpolation when the water shader samples with textureSampleLevel (linear filter).
  // Adjacent texels (+5, -5) blend to ~0, producing noise instead of waves.
  // Without the sign correction, DC sits at (0,0) instead of (N/2,N/2), which is an
  // invisible half-tile spatial shift since the ocean tiles seamlessly with repeat UV.

  // Read displacement from IFFT output (spatial domain, .r channel)
  // After IFFT, the real part (.r) contains the spatial-domain value
  let rawDy = textureLoad(inputDy, vec2i(gid.xy), 0).r;
  let rawDx = textureLoad(inputDx, vec2i(gid.xy), 0).r;
  let rawDz = textureLoad(inputDz, vec2i(gid.xy), 0).r;

  // Negate height: the standard-order IFFT (DC at index 0, no centered sign flip)
  // produces inverted height. Crests should point up, troughs down.
  let dy = -rawDy * amplitudeScale;
  let dx = rawDx;
  let dz = rawDz;

  // Store displacement (Y = height, X/Z = horizontal choppiness)
  textureStore(outputDisplacement, gid.xy, vec4f(dx, dy, dz, 0.0));

  // Read analytical slopes from IFFT output (spatial domain)
  // These were computed in frequency domain as i·kx·H(k,t) and i·kz·H(k,t),
  // then transformed to spatial domain by their own IFFT butterfly passes.
  let slopeX = textureLoad(inputSlopeX, vec2i(gid.xy), 0).r * amplitudeScale;
  let slopeZ = textureLoad(inputSlopeZ, vec2i(gid.xy), 0).r * amplitudeScale;

  // Surface normal from analytical slopes: N = normalize(-∂h/∂x, 1, -∂h/∂z)
  let N = normalize(vec3f(-slopeX, 1.0, -slopeZ));

  // Store normal packed 0-1
  textureStore(outputNormal, gid.xy, vec4f(N * 0.5 + 0.5, 0.0));
}
