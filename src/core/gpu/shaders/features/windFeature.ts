import type { ShaderFeature } from '../composition/types';
import { RES } from '../composition/resourceNames';

/**
 * Wind feature module — vertex displacement for vegetation animation
 * with optional debug visualization modes.
 *
 * Applies quadratic height-based wind displacement to vertex positions.
 * Wind physics (spring simulation) runs on the CPU in WindSystem;
 * the resulting displacement values are written to per-object uniforms.
 *
 * Debug modes (windDebugMode uniform):
 *   0 = off (normal rendering)
 *   1 = wind-type: leaf=green, branch=brown, untagged=gray
 *   2 = height-factor: grayscale gradient from anchor height
 *   3 = displacement: color ramp (blue→cyan→green→yellow→red) for wind magnitude
 *
 * windDebugMaterialType (per-submesh):
 *   0 = untagged, 1 = leaf, 2 = branch
 */
export const windFeature: ShaderFeature = {
  id: 'wind',
  stage: 'both',

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
    {
      name: RES.WIND_DEBUG_MODE,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
    {
      name: RES.WIND_DEBUG_MATERIAL_TYPE,
      kind: 'uniform',
      wgslType: 'f32',
      group: 'perObject',
      provider: 'WindComponent',
    },
  ],

  functions: `
// ============ Wind Functions ============

fn applyWind(pos: vec3f, windTime: f32) -> vec3f {
  // Material type: 0=untagged, 1=leaf, 2=branch
  let matType = u32(material.windDebugMaterialType + 0.5);

  // Height factor: quadratic falloff from anchor height (local-space Y).
  // Vertices at or below anchorHeight get no displacement.
  let heightAboveAnchor = max(pos.y - material.windAnchorHeight, 0.0);
  let heightFactor = saturate(heightAboveAnchor * heightAboveAnchor * 0.25);

  var displaced = pos;

  if (matType == 1u) {
    // ---- Leaf: high-frequency flutter + base sway ----
    let flutterA = sin(windTime * 14.0 + pos.x * 9.0 + pos.z * 13.0);
    let flutterB = sin(windTime * 19.0 + pos.x * 15.0 + pos.z * 7.0) * 0.6;
    let flutterC = sin(windTime * 23.0 + pos.y * 11.0 + pos.x * 3.0) * 0.3;
    let flutter = (flutterA + flutterB + flutterC) * material.windTurbulence * 0.10;
    displaced.x += (material.windDisplacementX + flutter) * heightFactor;
    displaced.z += (material.windDisplacementZ + flutter * 0.7) * heightFactor;
    // Slight vertical flutter for leaves
    displaced.y += flutter * 0.3 * heightFactor;
  } else if (matType == 2u) {
    // ---- Branch: slower, heavier sway, no flutter ----
    let branchSway = sin(windTime * 2.5 + pos.y * 1.5) * material.windTurbulence * 0.02;
    let branchFactor = heightFactor * 0.6; // branches resist more than leaves
    displaced.x += (material.windDisplacementX + branchSway) * branchFactor;
    displaced.z += (material.windDisplacementZ + branchSway * 0.5) * branchFactor;
  } else {
    // ---- Untagged: basic displacement, mild sway ----
    let sway = sin(windTime * 4.0 + pos.x * 3.0 + pos.z * 5.0) * material.windTurbulence * 0.03;
    displaced.x += (material.windDisplacementX + sway) * heightFactor;
    displaced.z += (material.windDisplacementZ + sway * 0.5) * heightFactor;
  }

  return displaced;
}

// Wind debug: 5-stop color ramp for displacement magnitude (blue→cyan→green→yellow→red)
fn windDebugColorRamp(t: f32) -> vec3f {
  let clamped = saturate(t);
  if (clamped < 0.25) {
    return mix(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 1.0), clamped * 4.0);
  } else if (clamped < 0.5) {
    return mix(vec3f(0.0, 1.0, 1.0), vec3f(0.0, 1.0, 0.0), (clamped - 0.25) * 4.0);
  } else if (clamped < 0.75) {
    return mix(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 1.0, 0.0), (clamped - 0.5) * 4.0);
  }
  return mix(vec3f(1.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), (clamped - 0.75) * 4.0);
}
`,

  vertexInject: `
  output.localY = localPos.y;
  localPos = applyWind(localPos, material.windTime);
`,

  varyings: `
  @location(4) localY: f32,
`,

  fragmentPostInject: `
  // ---- Wind Debug Visualization ----
  let windDbgMode = u32(material.windDebugMode + 0.5);
  if (windDbgMode == 1u) {
    // Mode 1: Wind Type — leaf=green, branch=brown, untagged=gray
    let matType = u32(material.windDebugMaterialType + 0.5);
    if (matType == 1u) {
      color = vec3f(0.2, 0.8, 0.15); // leaf green
    } else if (matType == 2u) {
      color = vec3f(0.55, 0.35, 0.15); // branch brown
    } else {
      color = vec3f(0.5, 0.5, 0.5); // untagged gray
    }
  } else if (windDbgMode == 2u) {
    // Mode 2: Height Factor — grayscale from local vertex height relative to anchor
    // Same formula as applyWind(): saturate(h² * 0.25) where h = localY - anchorHeight
    let hAbove = max(input.localY - material.windAnchorHeight, 0.0);
    let heightFactor = saturate(hAbove * hAbove * 0.25);
    color = vec3f(heightFactor, heightFactor, heightFactor);
  } else if (windDbgMode == 3u) {
    // Mode 3: Displacement — color ramp for wind influence magnitude
    let dispMag = length(vec2f(material.windDisplacementX, material.windDisplacementZ));
    let t = saturate(dispMag / 0.5); // normalize to reasonable range
    color = windDebugColorRamp(t);
  }
`,
};