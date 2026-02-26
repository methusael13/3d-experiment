import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Wind feature module — vertex displacement for vegetation animation.
 *
 * Applies quadratic height-based wind displacement to vertex positions.
 * Wind physics (spring simulation) runs on the CPU in WindSystem;
 * the resulting displacement values are written to per-object uniforms.
 *
 * Per-object uniform resources (added to MaterialUniforms struct).
 */
export const windFeature: ShaderFeature = {
  id: 'wind',
  stage: 'vertex',

  resources: [
    {
      name: RES.WIND_DISPLACEMENT_X,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_DISPLACEMENT_Z,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_ANCHOR_HEIGHT,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_STIFFNESS,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_TIME,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_TURBULENCE,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
  ],

  functions: `
// ============ Wind Functions ============

fn applyWind(pos: vec3f, windTime: f32) -> vec3f {
  // Height factor: quadratic falloff from anchor height
  // Vertices below anchorHeight are not affected; above it, displacement increases quadratically
  let heightAboveAnchor = max(pos.y - material.windAnchorHeight, 0.0);
  let normalizedHeight = saturate(heightAboveAnchor / max(1.0 - material.windAnchorHeight, 0.01));
  let heightFactor = normalizedHeight * normalizedHeight;

  // Micro-flutter: high-frequency per-vertex variation
  let flutter = sin(windTime * 8.0 + pos.x * 5.0 + pos.z * 7.0) * material.windTurbulence * 0.02;

  // Apply displacement
  var displaced = pos;
  displaced.x += (material.windDisplacementX + flutter) * heightFactor;
  displaced.z += (material.windDisplacementZ + flutter * 0.7) * heightFactor;

  return displaced;
}
`,

  vertexInject: `
  localPos = applyWind(localPos, material.windTime);
`,
};