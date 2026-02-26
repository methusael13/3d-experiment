import { System } from '../System';
import type { Entity } from '../Entity';
import type { ComponentType, SystemContext } from '../types';
import { TransformComponent } from '../components/TransformComponent';
import { LODComponent } from '../components/LODComponent';

/**
 * LODSystem — computes per-entity LOD level based on camera distance.
 *
 * Priority 10: runs early, after TransformSystem (0), before systems that
 * consume LOD (WetnessSystem at ~50, WindSystem at 50, MeshRenderSystem at 100).
 *
 * For each entity with LODComponent + TransformComponent, computes the
 * distance to the camera and maps it to a discrete LOD level using the
 * component's configurable thresholds.
 *
 * Camera position must be set externally each frame via `setCameraPosition()`.
 */
export class LODSystem extends System {
  readonly name = 'lod';
  readonly requiredComponents: readonly ComponentType[] = ['transform', 'lod'];
  priority = 10;

  /** Camera position — set externally by pipeline before world.update() */
  private _cameraPosition: [number, number, number] = [0, 0, 0];

  /**
   * Set the camera position for LOD distance calculations.
   * Called by the pipeline/viewport before world.update() each frame.
   */
  setCameraPosition(x: number, y: number, z: number): void {
    this._cameraPosition[0] = x;
    this._cameraPosition[1] = y;
    this._cameraPosition[2] = z;
  }

  update(entities: Entity[], _deltaTime: number, _context: SystemContext): void {
    const cx = this._cameraPosition[0];
    const cy = this._cameraPosition[1];
    const cz = this._cameraPosition[2];

    for (const entity of entities) {
      const transform = entity.getComponent<TransformComponent>('transform');
      const lod = entity.getComponent<LODComponent>('lod');
      if (!transform || !lod) continue;

      // Compute distance from entity position to camera
      const dx = transform.position[0] - cx;
      const dy = transform.position[1] - cy;
      const dz = transform.position[2] - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Find LOD level from thresholds
      let level = 0;
      for (let i = 0; i < lod.thresholds.length; i++) {
        if (dist >= lod.thresholds[i]) {
          level = i + 1;
        } else {
          break;
        }
      }

      lod.currentLOD = Math.min(level, lod.maxLOD);
    }
  }
}