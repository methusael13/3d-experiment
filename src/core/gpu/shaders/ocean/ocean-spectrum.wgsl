// Ocean Spectrum Generation (Phase W2)
// Generates initial complex amplitudes H₀(k) from JONSWAP/Phillips spectrum.
// Run once on parameter change (wind speed, direction, fetch).
//
// Output: rgba16float texture per cascade
//   .rg = H₀(k)  (real, imag)
//   .ba = conj(H₀(-k))  (real, imag)

const PI: f32 = 3.14159265359;
const G: f32 = 9.81;
const TAU: f32 = 6.28318530718;

struct SpectrumParams {
  // vec4: resolution, tileSize, windSpeed, windDirX
  params0: vec4f,
  // vec4: windDirZ, fetch, spectrumType, directionalSpread
  params1: vec4f,
  // vec4: swellMix, swellDirX, swellDirZ, swellWavelength
  params2: vec4f,
  // vec4: seed0, seed1, amplitudeScale, unused
  params3: vec4f,
}

@group(0) @binding(0) var outputSpectrum: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> specParams: SpectrumParams;

// ============================================================================
// Random number generation (box-muller from hash)
// ============================================================================

fn hash2(p: vec2u) -> vec2f {
  var s = p;
  s = s * vec2u(1597334673u, 3812015801u);
  s = s ^ (s >> vec2u(16u));
  s = s * vec2u(2246822519u, 3266489917u);
  s = s ^ (s >> vec2u(16u));
  return vec2f(s) / vec2f(4294967295.0);
}

fn gaussianRandom(coord: vec2u, seed: vec2f) -> vec2f {
  let h = hash2(coord + vec2u(u32(seed.x * 1000.0), u32(seed.y * 1000.0)));
  // Box-Muller transform
  let u1 = max(h.x, 1e-6);
  let u2 = h.y;
  let r = sqrt(-2.0 * log(u1));
  let theta = TAU * u2;
  return vec2f(r * cos(theta), r * sin(theta));
}

// ============================================================================
// Spectrum models
// ============================================================================

// Phillips spectrum
fn phillipsSpectrum(k: vec2f, windDir: vec2f, windSpeed: f32) -> f32 {
  let kLen = length(k);
  if (kLen < 0.0001) { return 0.0; }

  let L = windSpeed * windSpeed / G;
  let kLen2 = kLen * kLen;
  let kLen4 = kLen2 * kLen2;
  let kDotW = dot(normalize(k), windDir);

  // Phillips spectrum: A * exp(-1/(kL)^2) / k^4 * |k·w|^2
  let A = 1.0; // Amplitude normalization (scaled externally)
  let damping = 0.001; // Small wave suppression
  let l2 = damping * damping;

  return A * exp(-1.0 / (kLen2 * L * L)) / kLen4 * pow(abs(kDotW), 2.0) * exp(-kLen2 * l2);
}

// JONSWAP spectrum (1D) — extends Pierson-Moskowitz with peak enhancement
fn jonswapSpectrum1D(omega: f32, windSpeed: f32, fetch: f32) -> f32 {
  if (omega < 0.001) { return 0.0; }

  // Peak frequency from JONSWAP empirical relation
  let omegaP = 22.0 * pow(G * G / (windSpeed * fetch), 1.0 / 3.0);

  // Pierson-Moskowitz base spectrum
  let alpha = 0.076 * pow(windSpeed * windSpeed / (fetch * G), 0.22);
  let pm = alpha * G * G / pow(omega, 5.0) * exp(-1.25 * pow(omegaP / omega, 4.0));

  // JONSWAP peak enhancement
  let gamma = 3.3;
  let sigma = select(0.09, 0.07, omega <= omegaP);
  let r = exp(-pow(omega - omegaP, 2.0) / (2.0 * sigma * sigma * omegaP * omegaP));

  return pm * pow(gamma, r);
}

// Convert 1D frequency spectrum to 2D wavenumber spectrum using directional spread
fn jonswapSpectrum2D(k: vec2f, windDir: vec2f, windSpeed: f32, fetch: f32, spread: f32) -> f32 {
  let kLen = length(k);
  if (kLen < 0.0001) { return 0.0; }

  // Deep water dispersion: omega = sqrt(g * |k|)
  let omega = sqrt(G * kLen);

  // 1D frequency spectrum S(omega)
  let S = jonswapSpectrum1D(omega, windSpeed, fetch);

  // Convert from S(omega) to S(k) using Jacobian: dk/domega = 2*omega/g
  let jacobian = 2.0 * omega / G;
  let Sk = S / max(jacobian, 0.001);

  // Directional spreading (cosine-power)
  let kDir = normalize(k);
  let cosTheta = dot(kDir, windDir);
  let D = pow(max(cosTheta, 0.0), spread);

  return Sk * D / kLen; // Divide by |k| for 2D spreading normalization
}

// Pierson-Moskowitz fully developed sea spectrum
fn piersonMoskowitzSpectrum2D(k: vec2f, windDir: vec2f, windSpeed: f32, spread: f32) -> f32 {
  let kLen = length(k);
  if (kLen < 0.0001) { return 0.0; }

  let omega = sqrt(G * kLen);
  let omegaP = 0.855 * G / windSpeed;

  let alpha = 0.0081;
  let pm = alpha * G * G / pow(omega, 5.0) * exp(-1.25 * pow(omegaP / omega, 4.0));

  let jacobian = 2.0 * omega / G;
  let Sk = pm / max(jacobian, 0.001);

  let kDir = normalize(k);
  let cosTheta = dot(kDir, windDir);
  let D = pow(max(cosTheta, 0.0), spread);

  return Sk * D / kLen;
}

// ============================================================================
// Main compute shader
// ============================================================================

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let resolution = u32(specParams.params0.x);
  if (gid.x >= resolution || gid.y >= resolution) { return; }

  let tileSize = specParams.params0.y;
  let windSpeed = specParams.params0.z;
  let windDir = normalize(vec2f(specParams.params0.w, specParams.params1.x));
  let fetch = specParams.params1.y;
  let spectrumType = u32(specParams.params1.z);
  let spread = specParams.params1.w;
  let amplitudeScale = specParams.params3.z;
  let seed = specParams.params3.xy;

  // Wavenumber at this texel — STANDARD DFT ORDER (DC at index 0)
  // Index [0, N/2) → positive frequencies, [N/2, N) → negative frequencies
  // This matches what the Cooley-Tukey butterfly IFFT expects.
  let nx = select(i32(gid.x), i32(gid.x) - i32(resolution), gid.x >= resolution / 2u);
  let nz = select(i32(gid.y), i32(gid.y) - i32(resolution), gid.y >= resolution / 2u);
  let k = vec2f(f32(nx), f32(nz)) * TAU / tileSize;

  // Evaluate spectrum based on type
  var S: f32;
  if (spectrumType == 0u) {
    // Phillips
    S = phillipsSpectrum(k, windDir, windSpeed);
  } else if (spectrumType == 1u) {
    // JONSWAP
    S = jonswapSpectrum2D(k, windDir, windSpeed, fetch, spread);
  } else {
    // Pierson-Moskowitz
    S = piersonMoskowitzSpectrum2D(k, windDir, windSpeed, spread);
  }

  // ===== Swell contribution =====
  // Swell is a narrow-band spectrum from distant storms, blended with local wind waves.
  let swellMix = specParams.params2.x;
  if (swellMix > 0.001) {
    let swellDir = normalize(vec2f(specParams.params2.y, specParams.params2.z));
    let swellWavelength = max(specParams.params2.w, 10.0);
    let swellK = TAU / swellWavelength;

    // Narrow-band swell spectrum: Gaussian peak centered at swellK
    let kLen2 = dot(k, k);
    let swellKLen = sqrt(kLen2);
    // Peak width: narrower than wind waves (swell is well-organized)
    let swellSigma = swellK * 0.15; // 15% bandwidth
    let swellPeak = exp(-pow(swellKLen - swellK, 2.0) / (2.0 * swellSigma * swellSigma));

    // Directional focus: swell is very directional (high spread)
    let swellCosTheta = select(0.0, dot(normalize(k), swellDir), swellKLen > 0.0001);
    let swellSpread = pow(max(swellCosTheta, 0.0), spread * 4.0); // 4× narrower than wind waves

    // Swell amplitude: scale relative to wind spectrum energy
    let swellAmplitude = swellPeak * swellSpread * 0.5;

    // Blend: add swell on top of wind spectrum, weighted by swellMix
    S += swellAmplitude * swellMix;
  }

  // Apply amplitude scale
  // The raw spectrum values are very small (SI units: m²s). 
  // We need a large normalization factor based on tile size to produce 
  // meter-scale displacement after IFFT. The factor scales with tileSize² 
  // because the discrete spectrum → continuous transform involves area element dk².
  let dk = TAU / tileSize; // wavenumber resolution
  S *= amplitudeScale * dk * dk * tileSize * 0.5;

  // Generate Gaussian random complex number
  let xi = gaussianRandom(gid.xy, seed);

  // H₀(k) = 1/√2 * (ξ_r + i*ξ_i) * √(S(k))
  let sqrtS = sqrt(max(S, 0.0));
  let h0 = vec2f(xi.x * sqrtS, xi.y * sqrtS) * 0.70710678; // 1/√2

  // Conjugate: H₀*(-k) — needed for time evolution (Hermitian symmetry)
  // For -k, we use the symmetric texel
  let negCoord = vec2u(
    (resolution - gid.x) % resolution,
    (resolution - gid.y) % resolution
  );
  let xiNeg = gaussianRandom(negCoord, seed + vec2f(17.0, 31.0));

  // Evaluate spectrum at -k
  let kNeg = -k;
  var SNeg: f32;
  if (spectrumType == 0u) {
    SNeg = phillipsSpectrum(kNeg, windDir, windSpeed);
  } else if (spectrumType == 1u) {
    SNeg = jonswapSpectrum2D(kNeg, windDir, windSpeed, fetch, spread);
  } else {
    SNeg = piersonMoskowitzSpectrum2D(kNeg, windDir, windSpeed, spread);
  }
  SNeg *= amplitudeScale * dk * dk * tileSize * 0.5;

  let sqrtSNeg = sqrt(max(SNeg, 0.0));
  let h0Neg = vec2f(xiNeg.x * sqrtSNeg, -xiNeg.y * sqrtSNeg) * 0.70710678; // conj

  // Store: rg = H₀(k), ba = conj(H₀(-k))
  textureStore(outputSpectrum, gid.xy, vec4f(h0.x, h0.y, h0Neg.x, h0Neg.y));
}
