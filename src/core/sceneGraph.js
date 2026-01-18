/**
 * Scene Graph with BVH (Bounding Volume Hierarchy) for efficient spatial queries
 */

/**
 * Create an axis-aligned bounding box
 */
export function createAABB(min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]) {
  return { min: [...min], max: [...max] };
}

/**
 * Expand AABB to include a point
 */
export function expandAABB(aabb, point) {
  aabb.min[0] = Math.min(aabb.min[0], point[0]);
  aabb.min[1] = Math.min(aabb.min[1], point[1]);
  aabb.min[2] = Math.min(aabb.min[2], point[2]);
  aabb.max[0] = Math.max(aabb.max[0], point[0]);
  aabb.max[1] = Math.max(aabb.max[1], point[1]);
  aabb.max[2] = Math.max(aabb.max[2], point[2]);
}

/**
 * Merge two AABBs
 */
export function mergeAABB(a, b) {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

/**
 * Get AABB center
 */
export function getAABBCenter(aabb) {
  return [
    (aabb.min[0] + aabb.max[0]) * 0.5,
    (aabb.min[1] + aabb.max[1]) * 0.5,
    (aabb.min[2] + aabb.max[2]) * 0.5,
  ];
}

/**
 * Transform local AABB to world space given position, rotation (degrees), and scale
 */
export function transformAABB(localBounds, position, rotation, scale) {
  // Get 8 corners of local AABB
  const corners = [
    [localBounds.min[0], localBounds.min[1], localBounds.min[2]],
    [localBounds.max[0], localBounds.min[1], localBounds.min[2]],
    [localBounds.min[0], localBounds.max[1], localBounds.min[2]],
    [localBounds.max[0], localBounds.max[1], localBounds.min[2]],
    [localBounds.min[0], localBounds.min[1], localBounds.max[2]],
    [localBounds.max[0], localBounds.min[1], localBounds.max[2]],
    [localBounds.min[0], localBounds.max[1], localBounds.max[2]],
    [localBounds.max[0], localBounds.max[1], localBounds.max[2]],
  ];
  
  // Convert rotation to radians
  const rx = rotation[0] * Math.PI / 180;
  const ry = rotation[1] * Math.PI / 180;
  const rz = rotation[2] * Math.PI / 180;
  
  // Precompute trig
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  
  const worldBounds = createAABB();
  
  for (const corner of corners) {
    // Scale
    let x = corner[0] * scale[0];
    let y = corner[1] * scale[1];
    let z = corner[2] * scale[2];
    
    // Rotate X
    let y1 = y * cx - z * sx;
    let z1 = y * sx + z * cx;
    y = y1; z = z1;
    
    // Rotate Y
    let x1 = x * cy + z * sy;
    z1 = -x * sy + z * cy;
    x = x1; z = z1;
    
    // Rotate Z
    x1 = x * cz - y * sz;
    y1 = x * sz + y * cz;
    x = x1; y = y1;
    
    // Translate
    x += position[0];
    y += position[1];
    z += position[2];
    
    expandAABB(worldBounds, [x, y, z]);
  }
  
  return worldBounds;
}

/**
 * Ray-AABB intersection test (slab method)
 * @returns {number|null} Distance to intersection or null
 */
export function rayIntersectsAABB(rayOrigin, rayDir, aabb) {
  let tmin = -Infinity;
  let tmax = Infinity;
  
  for (let i = 0; i < 3; i++) {
    if (Math.abs(rayDir[i]) < 1e-8) {
      // Ray parallel to slab
      if (rayOrigin[i] < aabb.min[i] || rayOrigin[i] > aabb.max[i]) {
        return null;
      }
    } else {
      const invD = 1 / rayDir[i];
      let t0 = (aabb.min[i] - rayOrigin[i]) * invD;
      let t1 = (aabb.max[i] - rayOrigin[i]) * invD;
      
      if (invD < 0) {
        [t0, t1] = [t1, t0];
      }
      
      tmin = Math.max(tmin, t0);
      tmax = Math.min(tmax, t1);
      
      if (tmax < tmin) {
        return null;
      }
    }
  }
  
  return tmin >= 0 ? tmin : (tmax >= 0 ? tmax : null);
}

/**
 * Create scene graph with BVH support
 */
export function createSceneGraph() {
  const nodes = new Map(); // id -> SceneNode
  let bvhRoot = null;
  let bvhDirty = true;
  
  /**
   * Add a node to the scene
   */
  function addNode(id, options = {}) {
    const {
      position = [0, 0, 0],
      rotation = [0, 0, 0],
      scale = [1, 1, 1],
      localBounds = createAABB([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]),
      userData = null,
    } = options;
    
    const node = {
      id,
      position: [...position],
      rotation: [...rotation],
      scale: [...scale],
      localBounds,
      worldBounds: null,
      userData,
    };
    
    // Compute initial world bounds
    node.worldBounds = transformAABB(localBounds, position, rotation, scale);
    
    nodes.set(id, node);
    bvhDirty = true;
    
    return node;
  }
  
  /**
   * Remove a node from the scene
   */
  function removeNode(id) {
    const removed = nodes.delete(id);
    if (removed) {
      bvhDirty = true;
    }
    return removed;
  }
  
  /**
   * Update node transform
   */
  function updateNode(id, updates = {}) {
    const node = nodes.get(id);
    if (!node) return null;
    
    let boundsChanged = false;
    
    if (updates.position) {
      node.position = [...updates.position];
      boundsChanged = true;
    }
    if (updates.rotation) {
      node.rotation = [...updates.rotation];
      boundsChanged = true;
    }
    if (updates.scale) {
      node.scale = [...updates.scale];
      boundsChanged = true;
    }
    if (updates.localBounds) {
      node.localBounds = updates.localBounds;
      boundsChanged = true;
    }
    if (updates.userData !== undefined) {
      node.userData = updates.userData;
    }
    
    if (boundsChanged) {
      node.worldBounds = transformAABB(node.localBounds, node.position, node.rotation, node.scale);
      bvhDirty = true;
    }
    
    return node;
  }
  
  /**
   * Get a node by ID
   */
  function getNode(id) {
    return nodes.get(id) || null;
  }
  
  /**
   * Get all nodes
   */
  function getAllNodes() {
    return Array.from(nodes.values());
  }
  
  /**
   * Build BVH from current nodes (median split)
   */
  function rebuildBVH() {
    const nodeList = getAllNodes();
    
    if (nodeList.length === 0) {
      bvhRoot = null;
      bvhDirty = false;
      return;
    }
    
    bvhRoot = buildBVHNode(nodeList, 0);
    bvhDirty = false;
  }
  
  function buildBVHNode(nodeList, depth) {
    if (nodeList.length === 0) return null;
    
    // Compute bounds of all nodes
    let bounds = createAABB();
    for (const node of nodeList) {
      bounds = mergeAABB(bounds, node.worldBounds);
    }
    
    // Leaf node
    if (nodeList.length === 1) {
      return {
        bounds,
        left: null,
        right: null,
        leaf: nodeList[0],
      };
    }
    
    // Choose split axis (cycle through X, Y, Z based on depth)
    const axis = depth % 3;
    
    // Sort by AABB center on chosen axis
    nodeList.sort((a, b) => {
      const centerA = getAABBCenter(a.worldBounds);
      const centerB = getAABBCenter(b.worldBounds);
      return centerA[axis] - centerB[axis];
    });
    
    // Split at median
    const mid = Math.floor(nodeList.length / 2);
    const leftNodes = nodeList.slice(0, mid);
    const rightNodes = nodeList.slice(mid);
    
    return {
      bounds,
      left: buildBVHNode(leftNodes, depth + 1),
      right: buildBVHNode(rightNodes, depth + 1),
      leaf: null,
    };
  }
  
  /**
   * Cast ray through scene, return closest hit
   * @returns {{ node: SceneNode, distance: number, hitPoint: number[] } | null}
   */
  function castRay(rayOrigin, rayDir) {
    if (bvhDirty) {
      rebuildBVH();
    }
    
    if (!bvhRoot) return null;
    
    // Normalize ray direction
    const len = Math.sqrt(rayDir[0] ** 2 + rayDir[1] ** 2 + rayDir[2] ** 2);
    const dir = [rayDir[0] / len, rayDir[1] / len, rayDir[2] / len];
    
    let closestHit = null;
    let closestDist = Infinity;
    
    function traverse(bvhNode) {
      if (!bvhNode) return;
      
      // Early out if ray doesn't hit this node's bounds
      const boxDist = rayIntersectsAABB(rayOrigin, dir, bvhNode.bounds);
      if (boxDist === null || boxDist > closestDist) return;
      
      if (bvhNode.leaf) {
        // Test against leaf node's bounds more precisely
        const dist = rayIntersectsAABB(rayOrigin, dir, bvhNode.leaf.worldBounds);
        if (dist !== null && dist < closestDist) {
          closestDist = dist;
          closestHit = {
            node: bvhNode.leaf,
            distance: dist,
            hitPoint: [
              rayOrigin[0] + dir[0] * dist,
              rayOrigin[1] + dir[1] * dist,
              rayOrigin[2] + dir[2] * dist,
            ],
          };
        }
      } else {
        // Traverse children (front-to-back order for efficiency)
        const leftDist = bvhNode.left ? rayIntersectsAABB(rayOrigin, dir, bvhNode.left.bounds) : null;
        const rightDist = bvhNode.right ? rayIntersectsAABB(rayOrigin, dir, bvhNode.right.bounds) : null;
        
        if (leftDist !== null && rightDist !== null) {
          // Visit closer child first
          if (leftDist < rightDist) {
            traverse(bvhNode.left);
            traverse(bvhNode.right);
          } else {
            traverse(bvhNode.right);
            traverse(bvhNode.left);
          }
        } else if (leftDist !== null) {
          traverse(bvhNode.left);
        } else if (rightDist !== null) {
          traverse(bvhNode.right);
        }
      }
    }
    
    traverse(bvhRoot);
    
    return closestHit;
  }
  
  /**
   * Query all nodes intersecting an AABB
   */
  function queryBounds(queryAABB) {
    if (bvhDirty) {
      rebuildBVH();
    }
    
    const results = [];
    
    function aabbIntersects(a, b) {
      return (
        a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
        a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
        a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
      );
    }
    
    function traverse(bvhNode) {
      if (!bvhNode) return;
      
      if (!aabbIntersects(bvhNode.bounds, queryAABB)) return;
      
      if (bvhNode.leaf) {
        if (aabbIntersects(bvhNode.leaf.worldBounds, queryAABB)) {
          results.push(bvhNode.leaf);
        }
      } else {
        traverse(bvhNode.left);
        traverse(bvhNode.right);
      }
    }
    
    traverse(bvhRoot);
    
    return results;
  }
  
  /**
   * Clear all nodes
   */
  function clear() {
    nodes.clear();
    bvhRoot = null;
    bvhDirty = false;
  }
  
  /**
   * Get node count
   */
  function size() {
    return nodes.size;
  }
  
  return {
    addNode,
    removeNode,
    updateNode,
    getNode,
    getAllNodes,
    rebuildBVH,
    castRay,
    queryBounds,
    clear,
    size,
  };
}

/**
 * Compute bounding box from GLB model vertices
 * Works with our simplified mesh format from loadGLB (positions as Float32Array)
 */
export function computeBoundsFromGLB(glbModel) {
  const bounds = createAABB();
  
  for (const mesh of glbModel.meshes) {
    // Our loadGLB format has positions directly as Float32Array
    if (mesh.positions) {
      const positions = mesh.positions;
      const count = positions.length / 3;
      
      for (let i = 0; i < count; i++) {
        expandAABB(bounds, [
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
        ]);
      }
    }
  }
  
  // If no valid bounds found, return unit cube
  if (bounds.min[0] === Infinity) {
    return createAABB([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  }
  
  return bounds;
}
