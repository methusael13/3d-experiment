/**
 * Skeleton compatibility and animation remapping utilities.
 */

import type { GLBSkeleton, GLBJoint, GLBAnimationClip } from '../../loaders/types';
import { loadAnimationClips } from '../../loaders';

/**
 * Check if an animation's skeleton is compatible with a character's skeleton.
 * Compatible means: same number of joints, same names, same hierarchy.
 *
 * @param meshSkeleton - The character's skeleton (from mesh+armature GLB)
 * @param animSkeleton - The animation source's skeleton (from animation-only GLB)
 * @returns true if animations can be applied to the character
 */
export function isSkeletonCompatible(
  meshSkeleton: GLBSkeleton,
  animSkeleton: GLBSkeleton,
): boolean {
  if (meshSkeleton.joints.length !== animSkeleton.joints.length) return false;
  for (let i = 0; i < meshSkeleton.joints.length; i++) {
    if (meshSkeleton.joints[i].name !== animSkeleton.joints[i].name) return false;
    if (meshSkeleton.joints[i].parentIndex !== animSkeleton.joints[i].parentIndex) return false;
  }
  return true;
}

/**
 * Remap animation channels from one skeleton ordering to another.
 * Needed when joint ordering differs between mesh and animation GLBs
 * (uncommon with Mixamo but possible with hand-authored rigs).
 *
 * @param clip - The animation clip to remap
 * @param sourceJoints - Joint names from the animation source skeleton
 * @param targetJoints - Joint names from the character's skeleton
 * @returns Remapped clip with jointIndex values corrected for the target skeleton
 */
export function remapAnimationClip(
  clip: GLBAnimationClip,
  sourceJoints: GLBJoint[],
  targetJoints: GLBJoint[],
): GLBAnimationClip {
  // Build name → target index mapping
  const nameToTargetIndex = new Map<string, number>();
  for (const joint of targetJoints) {
    nameToTargetIndex.set(joint.name, joint.index);
  }

  const remappedChannels = clip.channels
    .map(ch => {
      const sourceName = sourceJoints[ch.jointIndex]?.name;
      const targetIndex = sourceName ? (nameToTargetIndex.get(sourceName) ?? -1) : -1;
      return { ...ch, jointIndex: targetIndex };
    })
    .filter(ch => ch.jointIndex >= 0); // Drop channels for joints that don't exist in target

  return {
    name: clip.name,
    duration: clip.duration,
    channels: remappedChannels,
  };
}

// ============================================================================
// Animation Clip Cache
// ============================================================================

/**
 * Simple URL-keyed cache for animation clip data.
 * Multiple characters sharing the same animation clips load keyframe data once.
 * GLBAnimationClip data is read-only after loading, so sharing by reference is safe.
 */
const animationClipCache = new Map<string, { clips: GLBAnimationClip[]; skeleton: GLBSkeleton | null }>();

/**
 * Load animation clips from a GLB file, with caching.
 * Returns cached data if the same URL was loaded before.
 *
 * @param url - URL to the GLB file containing animations
 * @returns Object with clips array and source skeleton
 */
export async function loadAnimationClipsCached(
  url: string,
): Promise<{ clips: GLBAnimationClip[]; skeleton: GLBSkeleton | null }> {
  const cached = animationClipCache.get(url);
  if (cached) return cached;

  const result = await loadAnimationClips(url);
  animationClipCache.set(url, result);
  return result;
}

/**
 * Clear the animation clip cache (e.g., on scene reset).
 */
export function clearAnimationClipCache(): void {
  animationClipCache.clear();
}
