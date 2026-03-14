/**
 * LayerBoundsGizmo - Oriented rectangle gizmo for editing terrain layer bounds
 *
 * Visualizes and allows interactive editing of a TerrainLayerBounds:
 * - Oriented rectangle outline projected onto the XZ terrain plane (Y=0)
 * - 4 corner handles for proportional resize
 * - 4 edge midpoint handles for single-axis resize
 * - Rotation handle (arc + knob at one edge midpoint)
 * - Dashed feather boundary ring showing the falloff region
 * - Color-coded per active layer
 *
 * Unlike the standard transform gizmos which extend BaseGizmo and operate on
 * entity transforms, this gizmo works directly with TerrainLayerBounds data
 * and renders flat on the XZ plane. It reuses GizmoRendererGPU's line/triangle
 * pipelines via the `renderDynamicLines` and `renderDynamicTriangles` helpers.
 */

import { mat4 } from 'gl-matrix';
import type { GizmoCamera } from './BaseGizmo';
import type { GizmoRendererGPU, GizmoColor } from '../../../core/gpu/renderers/GizmoRendererGPU';
import type { TerrainLayerBounds } from '../../../core/terrain/types';
import { screenToRay, rayPlaneIntersect } from '../../../core/utils/raycastUtils';

// ============================================================================
// Types
// ============================================================================

/** Handle identifiers for hit testing */
type BoundsHandle =
  | 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br'
  | 'edge-top' | 'edge-bottom' | 'edge-left' | 'edge-right'
  | 'rotate'
  | null;

/** Callback when bounds change during drag */
export type BoundsChangeCallback = (bounds: TerrainLayerBounds) => void;

// ============================================================================
// Constants
// ============================================================================

/** Handle hit radius in world units (auto-scaled by distance) */
const HANDLE_HIT_RADIUS_PX = 14;

/** Handle visual size as fraction of screen-space scale */
const HANDLE_SIZE = 0.04;

/** Height offset above Y=0 to avoid z-fighting with terrain */
const Y_OFFSET = 0.15;

/** Rotation handle offset beyond the edge (world fraction of halfExtent) */
const ROTATE_HANDLE_OFFSET = 0.25;

/** Feather dash pattern: dash length as fraction of feather perimeter */
const FEATHER_DASH_SEGMENTS = 48;

// Colors
const BOUNDS_COLOR: GizmoColor = [0.2, 0.8, 1.0, 1.0];       // Cyan outline
const BOUNDS_HIGHLIGHT: GizmoColor = [1.0, 0.8, 0.0, 1.0];   // Yellow highlight
const FEATHER_COLOR: GizmoColor = [0.2, 0.8, 1.0, 0.4];      // Cyan semi-transparent
const HANDLE_COLOR: GizmoColor = [1.0, 1.0, 1.0, 1.0];       // White handles
const HANDLE_HIGHLIGHT: GizmoColor = [1.0, 0.8, 0.0, 1.0];   // Yellow active
const ROTATE_COLOR: GizmoColor = [0.3, 1.0, 0.3, 1.0];       // Green rotation

// ============================================================================
// LayerBoundsGizmo
// ============================================================================

export class LayerBoundsGizmo {
  private readonly camera: GizmoCamera;

  // Current bounds being edited (mutable copy)
  private bounds: TerrainLayerBounds | null = null;

  // State
  private enabled = false;
  private activeHandle: BoundsHandle = null;
  private hoveredHandle: BoundsHandle = null;
  private isDraggingFlag = false;

  // Canvas dimensions for hit testing
  private canvasWidth = 800;
  private canvasHeight = 600;

  // Drag state
  private dragStartWorldPos: [number, number] = [0, 0]; // XZ
  private dragStartBounds: TerrainLayerBounds | null = null;

  // Callback
  private onChange: BoundsChangeCallback | null = null;

  // Pre-computed corners in world XZ (updated when bounds change)
  // Order: TL, TR, BR, BL (looking down Y axis, +X right, +Z down)
  private corners: Array<[number, number]> = [[0, 0], [0, 0], [0, 0], [0, 0]];
  private edgeMidpoints: Array<[number, number]> = [[0, 0], [0, 0], [0, 0], [0, 0]];
  private rotateHandlePos: [number, number] = [0, 0];

  constructor(camera: GizmoCamera) {
    this.camera = camera;
  }

  // ==================== Geometry Helpers ====================

  /**
   * Rotate a 2D point around origin by angle (radians)
   */
  private rotatePoint(x: number, z: number, cosR: number, sinR: number): [number, number] {
    return [
      x * cosR - z * sinR,
      x * sinR + z * cosR,
    ];
  }

  /**
   * Recompute corner positions, edge midpoints, and rotation handle from current bounds
   */
  private updateGeometry(): void {
    if (!this.bounds) return;

    const { centerX, centerZ, halfExtentX, halfExtentZ, rotation, featherWidth } = this.bounds;
    const rad = (rotation * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // Local-space corners (before rotation): TL(-x,-z), TR(+x,-z), BR(+x,+z), BL(-x,+z)
    const localCorners: Array<[number, number]> = [
      [-halfExtentX, -halfExtentZ],
      [halfExtentX, -halfExtentZ],
      [halfExtentX, halfExtentZ],
      [-halfExtentX, halfExtentZ],
    ];

    // Transform to world
    for (let i = 0; i < 4; i++) {
      const [lx, lz] = localCorners[i];
      const [rx, rz] = this.rotatePoint(lx, lz, cosR, sinR);
      this.corners[i] = [centerX + rx, centerZ + rz];
    }

    // Edge midpoints: top, right, bottom, left
    this.edgeMidpoints[0] = this.midpoint(this.corners[0], this.corners[1]); // top
    this.edgeMidpoints[1] = this.midpoint(this.corners[1], this.corners[2]); // right
    this.edgeMidpoints[2] = this.midpoint(this.corners[2], this.corners[3]); // bottom
    this.edgeMidpoints[3] = this.midpoint(this.corners[3], this.corners[0]); // left

    // Rotation handle: offset beyond top edge midpoint (outward along local -Z)
    const outwardDist = Math.max(halfExtentZ * ROTATE_HANDLE_OFFSET, 1.5);
    const [ox, oz] = this.rotatePoint(0, -halfExtentZ - outwardDist, cosR, sinR);
    this.rotateHandlePos = [centerX + ox, centerZ + oz];
  }

  private midpoint(a: [number, number], b: [number, number]): [number, number] {
    return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5];
  }

  // ==================== Raycasting ====================

  /**
   * Cast screen coords to XZ plane (Y = Y_OFFSET) and return world XZ
   */
  private screenToXZ(screenX: number, screenY: number): [number, number] | null {
    const { rayOrigin, rayDir } = screenToRay(
      screenX, screenY, this.camera as any, this.canvasWidth, this.canvasHeight
    );
    const hit = rayPlaneIntersect(rayOrigin, rayDir, [0, Y_OFFSET, 0], [0, 1, 0]);
    if (!hit) return null;
    return [hit[0], hit[2]];
  }

  /**
   * Get screen-space distance between a world XZ point and screen coords
   */
  private screenDistToHandle(handleXZ: [number, number], screenX: number, screenY: number): number {
    const vpMatrix = this.camera.getViewProjectionMatrix();
    const worldPos: [number, number, number] = [handleXZ[0], Y_OFFSET, handleXZ[1]];

    // Project to clip space
    const pos4 = [worldPos[0], worldPos[1], worldPos[2], 1];
    const cx = vpMatrix[0] * pos4[0] + vpMatrix[4] * pos4[1] + vpMatrix[8] * pos4[2] + vpMatrix[12] * pos4[3];
    const cy = vpMatrix[1] * pos4[0] + vpMatrix[5] * pos4[1] + vpMatrix[9] * pos4[2] + vpMatrix[13] * pos4[3];
    const cw = vpMatrix[3] * pos4[0] + vpMatrix[7] * pos4[1] + vpMatrix[11] * pos4[2] + vpMatrix[15] * pos4[3];

    if (cw <= 0) return Infinity;

    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const sx = (ndcX * 0.5 + 0.5) * this.canvasWidth;
    const sy = (1 - (ndcY * 0.5 + 0.5)) * this.canvasHeight;

    return Math.sqrt((screenX - sx) ** 2 + (screenY - sy) ** 2);
  }

  /**
   * Hit-test all handles, return closest within threshold
   */
  private hitTestHandles(screenX: number, screenY: number): BoundsHandle {
    if (!this.bounds) return null;

    const threshold = HANDLE_HIT_RADIUS_PX;
    let bestDist = threshold;
    let bestHandle: BoundsHandle = null;

    // Corner handles
    const cornerNames: BoundsHandle[] = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'];
    for (let i = 0; i < 4; i++) {
      const d = this.screenDistToHandle(this.corners[i], screenX, screenY);
      if (d < bestDist) { bestDist = d; bestHandle = cornerNames[i]; }
    }

    // Edge midpoint handles
    const edgeNames: BoundsHandle[] = ['edge-top', 'edge-right', 'edge-bottom', 'edge-left'];
    for (let i = 0; i < 4; i++) {
      const d = this.screenDistToHandle(this.edgeMidpoints[i], screenX, screenY);
      if (d < bestDist) { bestDist = d; bestHandle = edgeNames[i]; }
    }

    // Rotation handle
    const rd = this.screenDistToHandle(this.rotateHandlePos, screenX, screenY);
    if (rd < bestDist) { bestDist = rd; bestHandle = 'rotate'; }

    return bestHandle;
  }

  // ==================== Drag Logic ====================

  handleMouseDown(screenX: number, screenY: number): boolean {
    if (!this.enabled || !this.bounds) return false;

    const handle = this.hitTestHandles(screenX, screenY);
    if (!handle) return false;

    this.isDraggingFlag = true;
    this.activeHandle = handle;
    this.dragStartBounds = { ...this.bounds };

    const xz = this.screenToXZ(screenX, screenY);
    if (xz) this.dragStartWorldPos = xz;

    return true;
  }

  handleMouseMove(screenX: number, screenY: number): boolean {
    if (!this.bounds) return false;

    // Update hover state (for highlighting)
    if (!this.isDraggingFlag) {
      this.hoveredHandle = this.hitTestHandles(screenX, screenY);
      return false;
    }

    if (!this.activeHandle || !this.dragStartBounds) return false;

    const currentXZ = this.screenToXZ(screenX, screenY);
    if (!currentXZ) return true;

    const dx = currentXZ[0] - this.dragStartWorldPos[0];
    const dz = currentXZ[1] - this.dragStartWorldPos[1];
    const start = this.dragStartBounds;

    if (this.activeHandle === 'rotate') {
      // Rotation: angle from center to current mouse position
      const angleRad = Math.atan2(
        currentXZ[0] - this.bounds.centerX,
        -(currentXZ[1] - this.bounds.centerZ)  // negate Z for screen-like convention
      );
      this.bounds.rotation = (angleRad * 180) / Math.PI;
    } else if (this.activeHandle.startsWith('corner-')) {
      // Corner resize: transform delta into local space, adjust halfExtents
      this.applyCornerResize(dx, dz, start);
    } else if (this.activeHandle.startsWith('edge-')) {
      // Edge resize: single-axis in local space
      this.applyEdgeResize(dx, dz, start);
    }

    this.updateGeometry();
    this.onChange?.(this.bounds);
    return true;
  }

  handleMouseUp(): void {
    this.isDraggingFlag = false;
    this.activeHandle = null;
    this.dragStartBounds = null;
  }

  /**
   * Apply corner resize - proportionally adjust both half-extents
   * The opposite corner stays fixed.
   */
  private applyCornerResize(dx: number, dz: number, start: TerrainLayerBounds): void {
    if (!this.bounds) return;

    const rad = (start.rotation * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // Transform world delta to local space
    const localDx = dx * cosR + dz * sinR;
    const localDz = -dx * sinR + dz * cosR;

    // Determine sign based on which corner
    let sx = 1, sz = 1;
    switch (this.activeHandle) {
      case 'corner-tl': sx = -1; sz = -1; break;
      case 'corner-tr': sx = 1; sz = -1; break;
      case 'corner-br': sx = 1; sz = 1; break;
      case 'corner-bl': sx = -1; sz = 1; break;
    }

    // Half the delta goes to extent, half to center offset
    const newHalfX = Math.max(0.5, start.halfExtentX + (localDx * sx) * 0.5);
    const newHalfZ = Math.max(0.5, start.halfExtentZ + (localDz * sz) * 0.5);

    // Shift center to keep opposite corner fixed
    const centerDx = (localDx * sx) * 0.5;
    const centerDz = (localDz * sz) * 0.5;
    const [wcx, wcz] = this.rotatePoint(centerDx, centerDz, cosR, -sinR);

    this.bounds.halfExtentX = newHalfX;
    this.bounds.halfExtentZ = newHalfZ;
    this.bounds.centerX = start.centerX + wcx;
    this.bounds.centerZ = start.centerZ + wcz;
  }

  /**
   * Apply edge resize - single-axis adjust
   */
  private applyEdgeResize(dx: number, dz: number, start: TerrainLayerBounds): void {
    if (!this.bounds) return;

    const rad = (start.rotation * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // Transform world delta to local space
    const localDx = dx * cosR + dz * sinR;
    const localDz = -dx * sinR + dz * cosR;

    switch (this.activeHandle) {
      case 'edge-top': {
        const newHalfZ = Math.max(0.5, start.halfExtentZ - localDz * 0.5);
        const centerDz = -localDz * 0.5;
        const [, wcz] = this.rotatePoint(0, centerDz, cosR, -sinR);
        this.bounds.halfExtentZ = newHalfZ;
        this.bounds.centerX = start.centerX;
        this.bounds.centerZ = start.centerZ + wcz;
        break;
      }
      case 'edge-bottom': {
        const newHalfZ = Math.max(0.5, start.halfExtentZ + localDz * 0.5);
        const centerDz = localDz * 0.5;
        const [, wcz] = this.rotatePoint(0, centerDz, cosR, -sinR);
        this.bounds.halfExtentZ = newHalfZ;
        this.bounds.centerX = start.centerX;
        this.bounds.centerZ = start.centerZ + wcz;
        break;
      }
      case 'edge-left': {
        const newHalfX = Math.max(0.5, start.halfExtentX - localDx * 0.5);
        const centerDx = -localDx * 0.5;
        const [wcx] = this.rotatePoint(centerDx, 0, cosR, -sinR);
        this.bounds.halfExtentX = newHalfX;
        this.bounds.centerX = start.centerX + wcx;
        this.bounds.centerZ = start.centerZ;
        break;
      }
      case 'edge-right': {
        const newHalfX = Math.max(0.5, start.halfExtentX + localDx * 0.5);
        const centerDx = localDx * 0.5;
        const [wcx] = this.rotatePoint(centerDx, 0, cosR, -sinR);
        this.bounds.halfExtentX = newHalfX;
        this.bounds.centerX = start.centerX + wcx;
        this.bounds.centerZ = start.centerZ;
        break;
      }
    }
  }

  // ==================== Rendering ====================

  /**
   * Render the bounds gizmo using the GizmoRendererGPU's dynamic line/triangle helpers.
   */
  renderGPU(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU
  ): void {
    if (!this.enabled || !this.bounds) return;

    const y = Y_OFFSET;

    // Rectangle outline and feather dash are now rendered by the CDLOD shader overlay
    // (terrain-conforming). Only interactive handles are rendered here as gizmo geometry.

    // ---- 1. Line from top-edge midpoint to rotation handle ----
    const topMid = this.edgeMidpoints[0];
    const rotLineVerts = [
      topMid[0], y, topMid[1],
      this.rotateHandlePos[0], y, this.rotateHandlePos[1],
    ];
    const rotColor = (this.activeHandle === 'rotate' || this.hoveredHandle === 'rotate')
      ? HANDLE_HIGHLIGHT : ROTATE_COLOR;
    renderer.renderDynamicLines(passEncoder, vpMatrix, rotLineVerts, rotColor);

    // ---- 2. Corner handles (small diamonds) ----
    const cornerNames: BoundsHandle[] = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'];
    for (let i = 0; i < 4; i++) {
      const isHit = this.activeHandle === cornerNames[i] || this.hoveredHandle === cornerNames[i];
      this.renderHandleDiamond(
        passEncoder, vpMatrix, renderer,
        this.corners[i], y, isHit ? HANDLE_HIGHLIGHT : HANDLE_COLOR
      );
    }

    // ---- 3. Edge midpoint handles (small squares) ----
    const edgeNames: BoundsHandle[] = ['edge-top', 'edge-right', 'edge-bottom', 'edge-left'];
    for (let i = 0; i < 4; i++) {
      const isHit = this.activeHandle === edgeNames[i] || this.hoveredHandle === edgeNames[i];
      this.renderHandleSquare(
        passEncoder, vpMatrix, renderer,
        this.edgeMidpoints[i], y, isHit ? HANDLE_HIGHLIGHT : HANDLE_COLOR
      );
    }

    // ---- 4. Rotation handle (circle/diamond) ----
    this.renderHandleDiamond(
      passEncoder, vpMatrix, renderer,
      this.rotateHandlePos, y,
      (this.activeHandle === 'rotate' || this.hoveredHandle === 'rotate')
        ? HANDLE_HIGHLIGHT : ROTATE_COLOR
    );
  }

  /**
   * Render the feather boundary as a dashed outer rectangle
   */
  private renderFeatherBoundary(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU,
    y: number
  ): void {
    if (!this.bounds) return;

    const { centerX, centerZ, halfExtentX, halfExtentZ, rotation, featherWidth } = this.bounds;
    const outerHX = halfExtentX + featherWidth;
    const outerHZ = halfExtentZ + featherWidth;
    const rad = (rotation * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    // Outer corners
    const outerCorners: Array<[number, number]> = [
      [-outerHX, -outerHZ],
      [outerHX, -outerHZ],
      [outerHX, outerHZ],
      [-outerHX, outerHZ],
    ].map(([lx, lz]) => {
      const [rx, rz] = this.rotatePoint(lx, lz, cosR, sinR);
      return [centerX + rx, centerZ + rz] as [number, number];
    });

    // Dashed lines along each edge
    const dashVerts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = outerCorners[i];
      const b = outerCorners[(i + 1) % 4];
      const edgeLen = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
      const dashCount = Math.max(4, Math.round(edgeLen / (featherWidth * 0.8)));

      for (let d = 0; d < dashCount; d += 2) {
        const t0 = d / dashCount;
        const t1 = Math.min((d + 1) / dashCount, 1);
        const x0 = a[0] + (b[0] - a[0]) * t0;
        const z0 = a[1] + (b[1] - a[1]) * t0;
        const x1 = a[0] + (b[0] - a[0]) * t1;
        const z1 = a[1] + (b[1] - a[1]) * t1;
        dashVerts.push(x0, y, z0, x1, y, z1);
      }
    }

    renderer.renderDynamicLines(passEncoder, vpMatrix, dashVerts, FEATHER_COLOR);
  }

  /**
   * Render a diamond-shaped handle at world XZ position
   */
  private renderHandleDiamond(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU,
    posXZ: [number, number],
    y: number,
    color: GizmoColor
  ): void {
    const s = this.getHandleWorldSize();
    const cx = posXZ[0];
    const cz = posXZ[1];

    // Diamond: 4 triangles forming a rhombus
    const verts = [
      // Top triangle
      cx, y, cz - s, cx + s, y, cz, cx, y + s * 0.5, cz,
      // Right triangle
      cx + s, y, cz, cx, y, cz + s, cx, y + s * 0.5, cz,
      // Bottom triangle
      cx, y, cz + s, cx - s, y, cz, cx, y + s * 0.5, cz,
      // Left triangle
      cx - s, y, cz, cx, y, cz - s, cx, y + s * 0.5, cz,
    ];

    renderer.renderDynamicTriangles(passEncoder, vpMatrix, verts, color);
  }

  /**
   * Render a small square handle at world XZ position
   */
  private renderHandleSquare(
    passEncoder: GPURenderPassEncoder,
    vpMatrix: mat4 | Float32Array,
    renderer: GizmoRendererGPU,
    posXZ: [number, number],
    y: number,
    color: GizmoColor
  ): void {
    const s = this.getHandleWorldSize() * 0.7;
    const cx = posXZ[0];
    const cz = posXZ[1];

    // Two triangles forming a quad
    const verts = [
      cx - s, y, cz - s, cx + s, y, cz - s, cx + s, y, cz + s,
      cx - s, y, cz - s, cx + s, y, cz + s, cx - s, y, cz + s,
    ];

    renderer.renderDynamicTriangles(passEncoder, vpMatrix, verts, color);
  }

  /**
   * Calculate handle size in world units based on camera distance
   * (keeps handles a constant pixel size on screen)
   */
  private getHandleWorldSize(): number {
    if (!this.bounds) return 0.5;

    const cameraPos = this.camera.getPosition();
    const handleCenter: [number, number, number] = [this.bounds.centerX, Y_OFFSET, this.bounds.centerZ];
    const dx = cameraPos[0] - handleCenter[0];
    const dy = cameraPos[1] - handleCenter[1];
    const dz = cameraPos[2] - handleCenter[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const fov = this.camera.getFOV?.() ?? (Math.PI / 4);
    const worldUnitsPerPixel = (2 * distance * Math.tan(fov / 2)) / this.canvasHeight;
    return worldUnitsPerPixel * 8; // 8 pixel radius handles
  }

  // ==================== Public API ====================

  /**
   * Set bounds data to visualize/edit (pass null to clear)
   */
  setBounds(bounds: TerrainLayerBounds | null): void {
    if (bounds) {
      // Deep copy to avoid external mutation
      this.bounds = { ...bounds };
      this.updateGeometry();
    } else {
      this.bounds = null;
    }
    // Reset drag state on bounds change
    this.isDraggingFlag = false;
    this.activeHandle = null;
    this.hoveredHandle = null;
  }

  /**
   * Get the current (possibly modified) bounds
   */
  getBounds(): TerrainLayerBounds | null {
    return this.bounds ? { ...this.bounds } : null;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      this.isDraggingFlag = false;
      this.activeHandle = null;
      this.hoveredHandle = null;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get isDragging(): boolean {
    return this.isDraggingFlag;
  }

  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  setOnChange(callback: BoundsChangeCallback | null): void {
    this.onChange = callback;
  }

  destroy(): void {
    this.bounds = null;
    this.onChange = null;
  }
}
