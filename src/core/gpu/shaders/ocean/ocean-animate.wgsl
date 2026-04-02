// Ocean Spectrum Animation (Phase W2)
// Time-evolves initial spectrum H₀(k) to produce animated frequency-domain
// displacement fields H(k,t) for Dy, Dx, Dz, plus analytical slope fields
// ∂h/∂x and ∂h/∂z for normal computation.
//
// Uses deep-water dispersion relation: ω(k) = √(g|k|)
// H(k,t) = H₀(k) × e^(iωt) + conj(H₀(-k)) × e^(-iωt)
//
// Output: 5× rg32float textures (complex: real, imag) in frequency domain
//   - Dy: height displacement
//   - Dx: horizontal X displacement (choppiness)
//   - Dz: horizontal Z displacement (choppiness)
//   - SlopeX: ∂h/∂x = i·kx · H(k,t) — analytical X slope for normals
//   - SlopeZ: ∂h/∂z = i·kz · H(k,t) — analytical Z slope for normals

const PI: f32 = 3.14159265359;
const G: f32 = 9.81;
const TAU: f32 = 6.28318530718;

struct AnimateParams {
  // vec4: resolution, tileSize, time, choppiness
  params0: vec4f,
}

@group(0) @binding(0) var inputSpectrum: texture_2d<f32>;
@group(0) @binding(1) var outputDy: texture_storage_2d<rg32float, write>;
@group(0) @binding(2) var outputDx: texture_storage_2d<rg32float, write>;
@group(0) @binding(3) var outputDz: texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var<uniform> animParams: AnimateParams;
@group(0) @binding(5) var outputSlopeX: texture_storage_2d<rg32float, write>;
@group(0) @binding(6) var outputSlopeZ: texture_storage_2d<rg32float, write>;

// Complex multiply: (a + bi)(c + di) = (ac - bd) + (ad + bc)i
fn complexMul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let resolution = u32(animParams.params0.x);
  if (gid.x >= resolution || gid.y >= resolution) { return; }

  let tileSize = animParams.params0.y;
  let time = animParams.params0.z;
  let choppiness = animParams.params0.w;

  // Read initial spectrum: rg = H₀(k), ba = conj(H₀(-k))
  let spectrum = textureLoad(inputSpectrum, vec2i(gid.xy), 0);
  let h0 = spectrum.rg;       // H₀(k)
  let h0NegConj = spectrum.ba; // conj(H₀(-k))

  // Wavenumber at this texel — STANDARD DFT ORDER (DC at index 0)
  // Must match ocean-spectrum.wgsl frequency layout.
  let nx = select(i32(gid.x), i32(gid.x) - i32(resolution), gid.x >= resolution / 2u);
  let nz = select(i32(gid.y), i32(gid.y) - i32(resolution), gid.y >= resolution / 2u);
  let k = vec2f(f32(nx), f32(nz)) * TAU / tileSize;
  let kLen = length(k);

  // Deep water dispersion: ω = √(g|k|)
  let omega = sqrt(G * max(kLen, 0.0001));

  // Time evolution: e^(iωt) = cos(ωt) + i·sin(ωt)
  let phase = omega * time;
  let expPos = vec2f(cos(phase), sin(phase));   // e^(+iωt)
  let expNeg = vec2f(cos(phase), -sin(phase));  // e^(-iωt)

  // H(k,t) = H₀(k) × e^(iωt) + conj(H₀(-k)) × e^(-iωt)
  let hkt = complexMul(h0, expPos) + complexMul(h0NegConj, expNeg);

  // Height displacement Dy(k,t) = H(k,t)
  textureStore(outputDy, gid.xy, vec4f(hkt.x, hkt.y, 0.0, 0.0));

  // Analytical slopes in frequency domain (Tessendorf):
  // ∂h/∂x(k,t) = i·kx · H(k,t)
  // ∂h/∂z(k,t) = i·kz · H(k,t)
  // Multiplying by i rotates: i·(a+bi) = (-b + ai)
  let iH = vec2f(-hkt.y, hkt.x); // i × H(k,t)
  let slopeX = iH * k.x;         // i·kx·H(k,t)
  let slopeZ = iH * k.y;         // i·kz·H(k,t)
  textureStore(outputSlopeX, gid.xy, vec4f(slopeX.x, slopeX.y, 0.0, 0.0));
  textureStore(outputSlopeZ, gid.xy, vec4f(slopeZ.x, slopeZ.y, 0.0, 0.0));

  // Horizontal displacement: Dx = -i·kx/|k| · H(k,t), Dz = -i·kz/|k| · H(k,t)
  // Multiplying by -i rotates complex number: -i·(a+bi) = (b - ai)
  // So -i·H = (hkt.y, -hkt.x)
  if (kLen > 0.0001) {
    let kNorm = k / kLen;
    let negIH = vec2f(hkt.y, -hkt.x); // -i × H(k,t)

    // Dx(k,t) = choppiness × kx/|k| × (-i·H(k,t))
    let dx = complexMul(vec2f(kNorm.x * choppiness, 0.0), negIH);
    // Dz(k,t) = choppiness × kz/|k| × (-i·H(k,t))
    let dz = complexMul(vec2f(kNorm.y * choppiness, 0.0), negIH);

    textureStore(outputDx, gid.xy, vec4f(dx.x, dx.y, 0.0, 0.0));
    textureStore(outputDz, gid.xy, vec4f(dz.x, dz.y, 0.0, 0.0));
  } else {
    textureStore(outputDx, gid.xy, vec4f(0.0, 0.0, 0.0, 0.0));
    textureStore(outputDz, gid.xy, vec4f(0.0, 0.0, 0.0, 0.0));
  }
}
