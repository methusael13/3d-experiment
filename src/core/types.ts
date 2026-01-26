/**
 * Core type aliases for consistent typing across the codebase.
 * These are pure type aliases with no runtime cost.
 */

/**
 * 2D vector tuple [x, y]
 */
export type Vec2 = [number, number];

/**
 * 3D vector tuple [x, y, z]
 * Used for positions, directions, rotations, scales
 */
export type Vec3 = [number, number, number];

/**
 * 4D vector tuple [x, y, z, w]
 * Used for quaternions, homogeneous coordinates
 */
export type Vec4 = [number, number, number, number];

/**
 * RGB color tuple [r, g, b] with values 0-1
 */
export type RGB = [number, number, number];

/**
 * RGBA color tuple [r, g, b, a] with values 0-1
 */
export type RGBA = [number, number, number, number];
