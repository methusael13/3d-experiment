// FFT Butterfly Pass (Phase W2)
// Cooley-Tukey radix-2 butterfly operation for inverse FFT.
// Dispatched log₂(N) times per axis (horizontal then vertical).
//
// Each pass reads from one ping-pong texture and writes to the other.
// The butterfly indices and twiddle factors are computed inline.
//
// For a 256×256 FFT: 8 horizontal passes + 8 vertical passes = 16 dispatches.

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

struct FFTParams {
  // vec4: resolution, passIndex, isVertical, totalPasses
  params0: vec4f,
}

@group(0) @binding(0) var inputTex: texture_2d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_2d<rg32float, write>;
@group(0) @binding(2) var<uniform> fftParams: FFTParams;

// Complex multiply
fn complexMul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Bit-reverse an index with the given number of bits
fn bitReverse(x: u32, bits: u32) -> u32 {
  var v = x;
  var r = 0u;
  for (var i = 0u; i < bits; i++) {
    r = (r << 1u) | (v & 1u);
    v = v >> 1u;
  }
  return r;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let N = u32(fftParams.params0.x);
  let passIndex = u32(fftParams.params0.y);
  let isVertical = fftParams.params0.z > 0.5;
  let totalPasses = u32(fftParams.params0.w);

  // The thread index along the FFT axis
  let threadIdx = gid.x;
  // The row/column perpendicular to the FFT axis
  let perpIdx = gid.y;

  if (threadIdx >= N || perpIdx >= N) { return; }

  // Butterfly parameters for this pass
  let butterflySpan = 1u << (passIndex + 1u); // distance between paired elements
  let halfSpan = butterflySpan >> 1u;
  let butterflyGroup = threadIdx / butterflySpan;
  let butterflyIdx = threadIdx % butterflySpan;

  let isTop = butterflyIdx < halfSpan;
  var topIdx: u32;
  var botIdx: u32;

  if (isTop) {
    topIdx = butterflyGroup * butterflySpan + butterflyIdx;
    botIdx = topIdx + halfSpan;
  } else {
    botIdx = butterflyGroup * butterflySpan + butterflyIdx;
    topIdx = botIdx - halfSpan;
  }

  // On first pass, apply bit-reversal permutation to input indices
  var readTop = topIdx;
  var readBot = botIdx;
  if (passIndex == 0u) {
    readTop = bitReverse(topIdx, totalPasses);
    readBot = bitReverse(botIdx, totalPasses);
  }

  // Read values (swap x/y coordinates based on axis)
  var coordTop: vec2i;
  var coordBot: vec2i;
  if (isVertical) {
    coordTop = vec2i(i32(perpIdx), i32(readTop));
    coordBot = vec2i(i32(perpIdx), i32(readBot));
  } else {
    coordTop = vec2i(i32(readTop), i32(perpIdx));
    coordBot = vec2i(i32(readBot), i32(perpIdx));
  }

  let valTop = textureLoad(inputTex, coordTop, 0).rg;
  let valBot = textureLoad(inputTex, coordBot, 0).rg;

  // Twiddle factor: W = e^(-2πi * k / N) for IFFT (positive exponent for IFFT)
  // k = butterflyIdx (if top), or butterflyIdx - halfSpan (if bottom... but we just use top idx)
  let k = f32(butterflyIdx % halfSpan);
  let twiddleAngle = TAU * k / f32(butterflySpan); // Positive for IFFT
  let twiddle = vec2f(cos(twiddleAngle), sin(twiddleAngle));

  // Butterfly operation
  let twiddledBot = complexMul(twiddle, valBot);
  var result: vec2f;
  if (isTop) {
    result = valTop + twiddledBot;
  } else {
    result = valTop - twiddledBot;
  }

  // No 1/N normalization — the spectrum amplitudes in ocean-spectrum.wgsl include
  // dk² * tileSize * 0.5 scaling that pre-accounts for the IFFT summation.
  // Adding 1/N² (= 1/65536 for N=256) makes displacement vanishingly small.

  // Write output
  var writeCoord: vec2i;
  if (isVertical) {
    writeCoord = vec2i(i32(perpIdx), i32(threadIdx));
  } else {
    writeCoord = vec2i(i32(threadIdx), i32(perpIdx));
  }

  textureStore(outputTex, writeCoord, vec4f(result.x, result.y, 0.0, 0.0));
}
