/**
 * Dynamic uniform buffer for CSM shadow passes
 * Each slot is 256-byte aligned (WebGPU requirement for dynamic offsets)
 * Slot layout: [cascade0, cascade1, cascade2, cascade3, singleMap]
 */
export const SHADOW_SLOT_SIZE = 256; // Must be 256-byte aligned

/**
 * Base slots for directional shadows: 4 CSM cascades + 1 single map
 */
export const DIRECTIONAL_SHADOW_SLOTS = 5;
/**
 * Index at which spot shadow slots start
 */
export const SPOT_SHADOW_SLOT_BASE = DIRECTIONAL_SHADOW_SLOTS;
/**
 * Max shadow slots of spot lights
 */
export const SPOT_SHADOW_SLOTS = 16;

/**
 * Index at which point shadow slots start
 */
export const POINT_SHADOW_SLOT_BASE = SPOT_SHADOW_SLOT_BASE + SPOT_SHADOW_SLOTS;
/**
 * Max shadow slots of spot lights. 4 lights x 6 matrices (cube map)
 */
export const POINT_SHADOW_SLOTS = 24;

export const MAX_SHADOW_SLOTS = DIRECTIONAL_SHADOW_SLOTS + SPOT_SHADOW_SLOTS + POINT_SHADOW_SLOTS;
