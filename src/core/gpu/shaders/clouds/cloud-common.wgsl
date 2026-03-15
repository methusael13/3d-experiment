/**
 * cloud-common.wgsl — Shared cloud utility functions
 *
 * Included by cloud-raymarch.wgsl via inline embedding.
 * Contains: remap, phase functions, height gradient, density function.
 */

const PI = 3.14159265358979;

// ========== Utility ==========

fn remap(value: f32, oldMin: f32, oldMax: f32, newMin: f32, newMax: f32) -> f32 {
  return newMin + (saturate((value - oldMin) / (oldMax - oldMin))) * (newMax - newMin);
}

// ========== Phase Functions ==========

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * PI * pow(denom, 1.5));
}

fn dualLobePhase(cosTheta: f32) -> f32 {
  // Blend forward and backward scattering for silver lining effect
  let forward = henyeyGreenstein(cosTheta, 0.8);
  let backward = henyeyGreenstein(cosTheta, -0.3);
  return mix(forward, backward, 0.2);
}

// ========== Height Gradient ==========

fn heightGradient(heightFrac: f32, cloudType: f32) -> f32 {
  // cloudType: 0.0 = stratus/overcast, 0.5 = stratocumulus, 1.0 = cumulus
  if (cloudType < 0.25) {
    // Stratus/overcast: thin flat slab
    return smoothstep(0.0, 0.05, heightFrac) * smoothstep(1.0, 0.95, heightFrac);
  } else if (cloudType < 0.6) {
    // Stratocumulus: slightly lumpy layer
    return smoothstep(0.0, 0.08, heightFrac) * smoothstep(1.0, 0.7, heightFrac);
  } else {
    // Cumulus: round bottom, puffy top
    return smoothstep(0.0, 0.1, heightFrac) * smoothstep(1.0, 0.6, heightFrac);
  }
}

// ========== Ray-Sphere Intersection ==========

/// Returns (tNear, tFar) for intersection of ray with sphere centered at origin.
/// Returns (-1, -1) if no intersection.
fn raySphereIntersect(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
  let a = dot(rd, rd);
  let b = 2.0 * dot(ro, rd);
  let c = dot(ro, ro) - radius * radius;
  let discriminant = b * b - 4.0 * a * c;

  if (discriminant < 0.0) {
    return vec2f(-1.0, -1.0);
  }

  let sqrtD = sqrt(discriminant);
  let t0 = (-b - sqrtD) / (2.0 * a);
  let t1 = (-b + sqrtD) / (2.0 * a);
  return vec2f(t0, t1);
}
