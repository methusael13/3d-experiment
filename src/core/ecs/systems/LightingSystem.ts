import { mat4, vec3, quat } from 'gl-matrix';
import { System } from '../System';
import type { ComponentType, SystemContext } from '../types';
import type { Entity } from '../Entity';
import { LightComponent } from '../components/LightComponent';
import { TransformComponent } from '../components/TransformComponent';
import type { LightBufferManager } from '../../gpu/renderers/LightBufferManager';
import type { ShadowRendererGPU } from '../../gpu/renderers/ShadowRendererGPU';
import type { MeshRenderSystem } from './MeshRenderSystem';

/**
 * LightingSystem — computes derived lighting values from LightComponent inputs.
 *
 * For each directional light entity, reads azimuth/elevation/ambientIntensity
 * and writes direction, effectiveColor, sunIntensityFactor, ambient, skyColor,
 * groundColor onto the same LightComponent.
 *
 * Priority 80: runs after transforms (0) and before frustum cull (85) / render (100).
 * This ensures computed light values are ready for the GPU pipeline to read.
 */
export class LightingSystem extends System {
  readonly name = 'lighting';
  readonly requiredComponents: readonly ComponentType[] = ['light'];

  /**
   * Optional reference to LightBufferManager for packing point/spot light GPU buffers.
   * Set externally by the Viewport after GPU initialization.
   */
  lightBufferManager: LightBufferManager | null = null;

  /**
   * Optional reference to ShadowRendererGPU for spot shadow atlas management.
   * Set externally by the Viewport after GPU initialization.
   */
  shadowRenderer: ShadowRendererGPU | null = null;

  /**
   * Camera frustum planes for CPU light culling.
   * Extracted from the scene camera's view-projection matrix each frame.
   * Set externally by Viewport before world.update().
   * Each plane is [a, b, c, d] where ax + by + cz + d = 0.
   */
  private frustumPlanes: [number, number, number, number][] = [];
  
  /**
   * Set the view-projection matrix for frustum culling.
   * Extracts 6 frustum planes from the VP matrix.
   */
  setViewProjectionMatrix(vp: Float32Array | ArrayLike<number>): void {
    this.frustumPlanes = LightingSystem.extractFrustumPlanes(vp);
  }

  /**
   * Extract 6 frustum planes from a 4x4 view-projection matrix.
   * Returns array of [a, b, c, d] plane equations (normalized).
   */
  private static extractFrustumPlanes(m: ArrayLike<number>): [number, number, number, number][] {
    const planes: [number, number, number, number][] = [];
    // Left
    planes.push(LightingSystem.normalizePlane(m[3] + m[0], m[7] + m[4], m[11] + m[8], m[15] + m[12]));
    // Right
    planes.push(LightingSystem.normalizePlane(m[3] - m[0], m[7] - m[4], m[11] - m[8], m[15] - m[12]));
    // Bottom
    planes.push(LightingSystem.normalizePlane(m[3] + m[1], m[7] + m[5], m[11] + m[9], m[15] + m[13]));
    // Top
    planes.push(LightingSystem.normalizePlane(m[3] - m[1], m[7] - m[5], m[11] - m[9], m[15] - m[13]));
    // Near
    planes.push(LightingSystem.normalizePlane(m[3] + m[2], m[7] + m[6], m[11] + m[10], m[15] + m[14]));
    // Far
    planes.push(LightingSystem.normalizePlane(m[3] - m[2], m[7] - m[6], m[11] - m[10], m[15] - m[14]));
    return planes;
  }

  private static normalizePlane(a: number, b: number, c: number, d: number): [number, number, number, number] {
    const len = Math.sqrt(a * a + b * b + c * c);
    if (len < 1e-8) return [0, 0, 0, 0];
    return [a / len, b / len, c / len, d / len];
  }

  /**
   * Test if a sphere (position + radius) intersects the camera frustum.
   * Returns true if the sphere is at least partially inside the frustum.
   */
  private sphereInFrustum(x: number, y: number, z: number, radius: number): boolean {
    for (const [a, b, c, d] of this.frustumPlanes) {
      const dist = a * x + b * y + c * z + d;
      if (dist < -radius) return false; // Sphere entirely outside this plane
    }
    return true;
  }

  constructor() {
    super();
    this.priority = 80;
  }

  /** Moonlight intensity relative to sunlight (≈3% of full sun) */
  static readonly MOON_INTENSITY = 0.03;

  /** Moonlight color (cool blue) */
  static readonly MOON_COLOR: [number, number, number] = [0.4, 0.5, 0.7];

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    const pointEntities: Entity[] = [];
    const spotEntities: Entity[] = [];

    for (const entity of entities) {
      const light = entity.getComponent<LightComponent>('light');
      if (!light || !light.enabled) continue;

      if (light.lightType === 'directional') {
        this.updateDirectionalLight(light);
      } else if (light.lightType === 'point') {
        // Point lights don't need direction computation (omnidirectional)
        pointEntities.push(entity);
      } else if (light.lightType === 'spot') {
        // Derive spot direction from entity's transform rotation quaternion.
        // Default forward: (0, -1, 0) — pointing down. Rotation rotates this.
        const transform = entity.getComponent<TransformComponent>('transform');
        if (transform) {
          light.direction = LightingSystem.directionFromQuat(transform.worldRotationQuat);
        }
        spotEntities.push(entity);
      }
    }

    // CPU frustum cull point/spot lights (sphere-frustum test)
    let visiblePoints = pointEntities;
    let visibleSpots = spotEntities;
    if (this.frustumPlanes.length > 0) {
      visiblePoints = pointEntities.filter(e => {
        const t = e.getComponent<TransformComponent>('transform');
        const l = e.getComponent<LightComponent>('light');
        if (!t || !l) return true; // keep if no transform
        const wp = t.worldPosition;
        return this.sphereInFrustum(wp[0], wp[1], wp[2], l.range ?? 10);
      });
      visibleSpots = spotEntities.filter(e => {
        const t = e.getComponent<TransformComponent>('transform');
        const l = e.getComponent<LightComponent>('light');
        if (!t || !l) return true;
        const wp = t.worldPosition;
        return this.sphereInFrustum(wp[0], wp[1], wp[2], l.range ?? 10);
      });
    }

    // Manage spot light shadow atlas slots and compute matrices
    if (this.shadowRenderer) {
      this.manageSpotShadowSlots(spotEntities);
    }

    // Pack visible point/spot lights into GPU buffers
    const hasMultiLights = visiblePoints.length > 0 || visibleSpots.length > 0;
    if (this.lightBufferManager) {
      // Populate shadow matrices from shadowRenderer before uploading
      if (this.shadowRenderer) {
        const matrices: (ArrayLike<number> | null)[] = [];
        for (let i = 0; i < visibleSpots.length; i++) {
          const light = visibleSpots[i].getComponent<LightComponent>('light');
          if (light && light.shadowAtlasIndex >= 0) {
            matrices.push(this.shadowRenderer.getSpotShadowMatrix(light.shadowAtlasIndex));
          } else {
            matrices.push(null);
          }
        }
        this.lightBufferManager._spotShadowMatrices = matrices;
      }
      this.lightBufferManager.update(visiblePoints, visibleSpots);
    }

    // Propagate multiLightActive flag to MeshRenderSystem so it includes
    // the 'multi-light' shader feature in variant key computation
    if (_context.world) {
      const meshRenderSystem = _context.world.getSystem<MeshRenderSystem>('mesh-render');
      if (meshRenderSystem) {
        meshRenderSystem.multiLightActive = hasMultiLights;
      }
    }
  }

  // ====================================================================
  // Spot shadow atlas management
  // ====================================================================

  /** Track which entity IDs have been allocated shadow slots */
  private allocatedShadowEntities: Set<string> = new Set();

  /** Track the max shadow resolution requested by any active spot light.
   *  When this changes, the atlas is resized. */
  private currentSpotShadowResolution: number = 0;

  /**
   * Auto-allocate/free shadow atlas slots for spot lights with castsShadow.
   * Computes perspective light-space matrix for each shadow-casting spot light.
   */
  private manageSpotShadowSlots(spotEntities: Entity[]): void {
    if (!this.shadowRenderer) return;

    const activeShadowIds = new Set<string>();
    const spotEntityMaps = new Map<string, Entity>();

    // Compute the maximum shadow resolution requested by any shadow-casting spot light.
    // All spot lights share a single atlas, so we use the max resolution.
    let maxSpotResolution = 0;
    for (const entity of spotEntities) {
      spotEntityMaps.set(entity.id, entity);

      const light = entity.getComponent<LightComponent>('light');
      const transform = entity.getComponent<TransformComponent>('transform');
      if (!light || !light.castsShadow) continue;

      if (light.shadowMapResolution > maxSpotResolution) {
        maxSpotResolution = light.shadowMapResolution;
      }

      activeShadowIds.add(entity.id);

      // Allocate slot if not already allocated
      if (light.shadowAtlasIndex < 0) {
        const slot = this.shadowRenderer.allocateShadowSlot(entity.id);
        light.shadowAtlasIndex = slot;
        if (slot >= 0) this.allocatedShadowEntities.add(entity.id);
      }

      if (light.shadowAtlasIndex < 0) continue; // No slot available

      // Compute perspective light-space matrix for this spot light
      const pos = transform ? transform.worldPosition : [0, 0, 0] as [number, number, number];
      const dir = light.direction;
      const range = light.range ?? 10;
      const outerAngle = light.outerConeAngle ?? Math.PI / 4;

      const lightSpaceMatrix = this.computeSpotLightMatrix(
        pos as [number, number, number],
        dir,
        range,
        outerAngle,
      );

      this.shadowRenderer.setSpotShadowMatrix(light.shadowAtlasIndex, lightSpaceMatrix);
    }

    // Resize spot shadow atlas if the max requested resolution changed
    if (maxSpotResolution > 0 && maxSpotResolution !== this.currentSpotShadowResolution) {
      if (this.shadowRenderer.resizeSpotShadowAtlas(maxSpotResolution)) {
        this.currentSpotShadowResolution = maxSpotResolution;
      }
    }

    // Free slots for spot lights that no longer cast shadows
    // Collect IDs to free first (can't modify Set while iterating)
    const toFree: string[] = [];
    for (const entityId of this.allocatedShadowEntities) {
      if (!activeShadowIds.has(entityId)) {
        toFree.push(entityId);
      }
    }
    for (const entityId of toFree) {
      this.shadowRenderer.freeShadowSlot(entityId);
      this.allocatedShadowEntities.delete(entityId);
      // Reset shadowAtlasIndex on the light component so the GPU buffer
      // no longer references the freed atlas layer
      const entity = spotEntityMaps.get(entityId);
      if (entity) {
        const lc = entity.getComponent<LightComponent>('light');
        if (lc) {
          lc.shadowAtlasIndex = -1;
        }
      }
    }
  }

  /**
   * Compute a perspective light-space matrix for a spot light.
   * Uses the spot's position, direction, range, and outer cone angle.
   */
  private computeSpotLightMatrix(
    position: [number, number, number],
    direction: [number, number, number],
    range: number,
    outerConeAngle: number,
  ): mat4 {
    const lightView = mat4.create();
    const lightProj = mat4.create();
    const lightSpaceMatrix = mat4.create();

    // Target = position + direction (unit vector, not scaled by range)
    // lookAt only needs the direction, not a specific distance
    const target: vec3 = [
      position[0] + direction[0],
      position[1] + direction[1],
      position[2] + direction[2],
    ];

    // Up vector: avoid degenerate case when direction is nearly vertical
    let up: vec3 = [0, 1, 0];
    if (Math.abs(direction[1]) > 0.99) {
      up = [0, 0, 1];
    }

    mat4.lookAt(lightView, position as vec3, target, up);

    // Perspective projection: FOV = 2 * outerConeAngle, aspect = 1 (square shadow map)
    const fov = outerConeAngle * 2;
    const near = 0.1;
    // Use perspectiveZO for WebGPU [0,1] depth range (not GL's [-1,1])
    // Shadow pipeline uses depthCompare: 'less' (standard, non-reversed-Z)
    mat4.perspectiveZO(lightProj, fov, 1.0, near, range);

    mat4.multiply(lightSpaceMatrix, lightProj, lightView);
    return lightSpaceMatrix;
  }

  /**
   * Compute all derived values for a directional (sun/moon) light.
   * Logic is ported 1:1 from DirectionalLight class methods.
   *
   * Weather dimming (light.weatherDimming) is applied AFTER the day/night
   * sunIntensityFactor computation so both effects stack correctly.
   * At night, weatherDimming still applies (clouds dim moonlight too).
   */
  private updateDirectionalLight(light: LightComponent): void {
    const azimuth = light.azimuth ?? 45;
    const elevation = light.elevation ?? 45;
    const ambientIntensity = light.ambientIntensity ?? 1.0;
    const weatherDim = Math.max(0, Math.min(1, light.weatherDimming));

    // ── Direction ────────────────────────────────────────────────────────
    light.direction = this.computeDirection(azimuth, elevation);

    // ── Sun intensity factor ─────────────────────────────────────────────
    light.sunIntensityFactor = this.computeSunIntensityFactor(elevation);

    // ── Effective color (day/night tint × sunIntensityFactor × weatherDimming) ──
    const baseColor = this.computeSunColor(elevation, light.sunIntensityFactor);
    light.effectiveColor = [
      baseColor[0] * weatherDim,
      baseColor[1] * weatherDim,
      baseColor[2] * weatherDim,
    ];

    // ── Ambient (elevation-based × ambientIntensity × weatherDimming) ────
    light.ambient = this.computeAmbient(elevation, ambientIntensity) * weatherDim;

    // ── Sky / ground hemisphere colors ───────────────────────────────────
    light.skyColor = this.computeSkyColor(elevation);
    light.groundColor = this.computeGroundColor(elevation);
  }

  // ====================================================================
  // Pure computation helpers (match DirectionalLight exactly)
  // ====================================================================

  /**
   * Calculate direction from azimuth and elevation.
   * During night (elevation < -5°), returns a "moon" direction:
   * the sun direction is mirrored to the opposite side of the sky.
   */
  private computeDirection(azimuth: number, elevation: number): [number, number, number] {
    const azRad = (azimuth * Math.PI) / 180;
    const elRad = (elevation * Math.PI) / 180;

    if (elevation < -5) {
      // Moon direction: opposite side of the sky from the sun
      const moonElRad = Math.abs(elRad);
      const moonAzRad = azRad + Math.PI;
      return [
        Math.cos(moonElRad) * Math.sin(moonAzRad),
        Math.sin(moonElRad),
        Math.cos(moonElRad) * Math.cos(moonAzRad),
      ];
    }

    return [
      Math.cos(elRad) * Math.sin(azRad),
      Math.sin(elRad),
      Math.cos(elRad) * Math.cos(azRad),
    ];
  }

  /**
   * Directional light intensity factor based on elevation.
   * Smoothly fades from 1.0 (full sun) to MOON_INTENSITY through twilight.
   */
  private computeSunIntensityFactor(elevation: number): number {
    const moon = LightingSystem.MOON_INTENSITY;
    if (elevation >= 5) return 1.0;
    if (elevation <= -5) return moon;
    const t = (elevation + 5) / 10;
    return moon + (1.0 - moon) * t;
  }

  /**
   * Effective light color based on elevation (sunset tint, moonlight at night).
   * Scaled by sunIntensityFactor.
   */
  private computeSunColor(
    elevation: number,
    factor: number,
  ): [number, number, number] {
    let r: number, g: number, b: number;

    if (elevation < -5) {
      // Night: cool blue moonlight color
      [r, g, b] = LightingSystem.MOON_COLOR;
    } else if (Math.abs(elevation) < 15) {
      // Sunset/sunrise/twilight tint
      const t = Math.abs(elevation) / 15;
      r = 1.0;
      g = 0.6 + 0.4 * t;
      b = 0.4 + 0.6 * t;
    } else {
      // Day: white light
      r = 1.0;
      g = 1.0;
      b = 0.95;
    }

    return [r * factor, g * factor, b * factor];
  }

  /**
   * Ambient based on sun elevation and user intensity multiplier.
   */
  private computeAmbient(elevation: number, ambientIntensity: number): number {
    let baseAmbient: number;
    if (elevation <= 0) {
      baseAmbient = 0.1 + (elevation + 90) / 900;
    } else {
      baseAmbient = 0.2 + elevation / 180;
    }
    return baseAmbient * ambientIntensity;
  }

  /**
   * Sky color for hemisphere ambient lighting based on elevation.
   */
  private computeSkyColor(elevation: number): [number, number, number] {
    if (elevation < -10) {
      return [0.1, 0.12, 0.2]; // Night
    }
    if (elevation < 5) {
      const t = (elevation + 10) / 15;
      return [0.1 + 0.5 * t, 0.12 + 0.28 * t, 0.2 + 0.3 * t]; // Twilight
    }
    if (elevation < 20) {
      const t = (elevation - 5) / 15;
      return [0.6 - 0.2 * t, 0.4 + 0.2 * t, 0.5 + 0.5 * t]; // Sunrise/sunset
    }
    return [0.4, 0.6, 1.0]; // Day
  }

  /**
   * Derive a normalized direction vector from a rotation quaternion.
   * Uses (0, -1, 0) as the default forward direction (pointing down),
   * so an identity quaternion produces a downward-facing light.
   */
  static directionFromQuat(q: quat): [number, number, number] {
    const forward: vec3 = [0, -1, 0];
    const result = vec3.create();
    vec3.transformQuat(result, forward, q);
    vec3.normalize(result, result);
    return [result[0], result[1], result[2]];
  }

  /**
   * Ground color for hemisphere ambient lighting based on elevation.
   */
  private computeGroundColor(elevation: number): [number, number, number] {
    if (elevation < 0) {
      return [0.05, 0.05, 0.08]; // Night
    }
    if (elevation < 20) {
      const t = elevation / 20;
      return [0.2 + 0.1 * t, 0.15 + 0.1 * t, 0.1 + 0.1 * t]; // Low sun
    }
    return [0.3, 0.25, 0.2]; // Day
  }
}