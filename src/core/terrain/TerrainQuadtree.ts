/**
 * TerrainQuadtree - CDLOD (Continuous Distance-Dependent LOD) terrain system
 * 
 * Implements a quadtree-based LOD selection for terrain rendering.
 * Each frame, the quadtree is traversed to select which nodes (terrain patches)
 * should be rendered based on camera distance and view frustum.
 * 
 * References:
 * - "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps" (Strugar, 2009)
 */

import { vec3, mat4 } from 'gl-matrix';

/**
 * Axis-Aligned Bounding Box
 */
export interface AABB {
  min: vec3;
  max: vec3;
}

/**
 * Frustum planes for culling (Ax + By + Cz + D = 0 form)
 */
export interface Frustum {
  planes: Float32Array[]; // 6 planes, each [A, B, C, D]
}

/**
 * A single node in the terrain quadtree
 */
export class TerrainNode {
  /** World-space bounding box */
  public readonly bounds: AABB;
  
  /** LOD level (0 = closest/highest detail, N = farthest/lowest detail) */
  public readonly lodLevel: number;
  
  /** Node position in grid units at this LOD level */
  public readonly gridX: number;
  public readonly gridZ: number;
  
  /** World-space center of this node */
  public readonly center: vec3;
  
  /** World-space size (width/depth, assuming square) */
  public readonly size: number;
  
  /** Child nodes (null if leaf or not subdivided) */
  public children: TerrainNode[] | null = null;
  
  /** Parent node (null for root) */
  public readonly parent: TerrainNode | null;
  
  /** Morph factor for smooth LOD transitions (0-1) */
  public morphFactor: number = 0;
  
  constructor(
    bounds: AABB,
    lodLevel: number,
    gridX: number,
    gridZ: number,
    parent: TerrainNode | null = null
  ) {
    this.bounds = bounds;
    this.lodLevel = lodLevel;
    this.gridX = gridX;
    this.gridZ = gridZ;
    this.parent = parent;
    
    // Calculate center and size from bounds
    this.center = vec3.fromValues(
      (bounds.min[0] + bounds.max[0]) * 0.5,
      (bounds.min[1] + bounds.max[1]) * 0.5,
      (bounds.min[2] + bounds.max[2]) * 0.5
    );
    this.size = bounds.max[0] - bounds.min[0];
  }
  
  /**
   * Check if this node has children
   */
  hasChildren(): boolean {
    return this.children !== null && this.children.length === 4;
  }
  
  /**
   * Get the child node at the given quadrant (0-3)
   * Quadrant layout:
   *   0 | 1
   *   -----
   *   2 | 3
   */
  getChild(quadrant: number): TerrainNode | null {
    return this.children?.[quadrant] ?? null;
  }
}

/**
 * Selection result for a single frame
 */
export interface SelectionResult {
  /** Nodes to render this frame */
  nodes: TerrainNode[];
  
  /** Total nodes considered */
  nodesConsidered: number;
  
  /** Nodes culled by frustum */
  nodesCulled: number;
}

/**
 * Configuration for the terrain quadtree
 */
export interface QuadtreeConfig {
  /** Total terrain world size (width = depth) */
  worldSize: number;
  
  /** Minimum node size (highest detail) */
  minNodeSize: number;
  
  /** Maximum LOD levels (0 = root, N = leaves) */
  maxLodLevels: number;
  
  /** LOD distance multiplier - nodes split when distance < size * multiplier */
  lodDistanceMultiplier: number;
  
  /** Morph region size (0-1, portion of node where morphing occurs) */
  morphRegion: number;
  
  /** Minimum height (Y) for bounding boxes */
  minHeight: number;
  
  /** Maximum height (Y) for bounding boxes */
  maxHeight: number;
}

/**
 * Default quadtree configuration
 */
export function createDefaultQuadtreeConfig(): QuadtreeConfig {
  return {
    worldSize: 1024,
    minNodeSize: 8,
    maxLodLevels: 10,         // Increased from 6 to prevent distant clipping
    lodDistanceMultiplier: 2.0,
    morphRegion: 0.3,
    minHeight: -100,          // Allow negative heights
    maxHeight: 200,           // Increased for larger terrains
  };
}

/**
 * TerrainQuadtree - Manages LOD selection for terrain rendering
 */
export class TerrainQuadtree {
  private config: QuadtreeConfig;
  private root: TerrainNode | null = null;
  
  // Selection state (reused each frame)
  private selectedNodes: TerrainNode[] = [];
  private nodesConsidered: number = 0;
  private nodesCulled: number = 0;
  
  // Cached frustum planes
  private frustumPlanes: Float32Array[] = [];
  
  constructor(config?: Partial<QuadtreeConfig>) {
    this.config = { ...createDefaultQuadtreeConfig(), ...config };
    this.buildTree();
    
    // Pre-allocate frustum planes
    for (let i = 0; i < 6; i++) {
      this.frustumPlanes.push(new Float32Array(4));
    }
  }
  
  /**
   * Build the static quadtree structure
   */
  private buildTree(): void {
    const { worldSize, minHeight, maxHeight } = this.config;
    const halfSize = worldSize * 0.5;
    
    // Root node covers entire terrain
    const rootBounds: AABB = {
      min: vec3.fromValues(-halfSize, minHeight, -halfSize),
      max: vec3.fromValues(halfSize, maxHeight, halfSize),
    };
    
    this.root = new TerrainNode(rootBounds, 0, 0, 0, null);
    
    // Recursively build children
    this.buildChildren(this.root);
  }
  
  /**
   * Recursively build child nodes
   */
  private buildChildren(node: TerrainNode): void {
    const { minNodeSize, maxLodLevels, minHeight, maxHeight } = this.config;
    
    // Stop if we've reached max LOD or minimum size
    if (node.lodLevel >= maxLodLevels - 1 || node.size <= minNodeSize) {
      return;
    }
    
    const halfSize = node.size * 0.5;
    const childLod = node.lodLevel + 1;
    
    node.children = [];
    
    // Create 4 child nodes (quadrants)
    for (let qz = 0; qz < 2; qz++) {
      for (let qx = 0; qx < 2; qx++) {
        const quadrant = qz * 2 + qx;
        
        const minX = node.bounds.min[0] + qx * halfSize;
        const minZ = node.bounds.min[2] + qz * halfSize;
        
        const childBounds: AABB = {
          min: vec3.fromValues(minX, minHeight, minZ),
          max: vec3.fromValues(minX + halfSize, maxHeight, minZ + halfSize),
        };
        
        const childGridX = node.gridX * 2 + qx;
        const childGridZ = node.gridZ * 2 + qz;
        
        const child = new TerrainNode(childBounds, childLod, childGridX, childGridZ, node);
        node.children.push(child);
        
        // Recurse
        this.buildChildren(child);
      }
    }
  }
  
  /**
   * Select visible nodes for rendering based on camera position and frustum
   */
  select(cameraPos: vec3, viewProjectionMatrix: mat4): SelectionResult {
    this.selectedNodes = [];
    this.nodesConsidered = 0;
    this.nodesCulled = 0;

    // Extract frustum planes from VP matrix
    this.extractFrustumPlanes(viewProjectionMatrix);
    
    // Traverse quadtree
    if (this.root) {
      this.selectNode(this.root, cameraPos);
    }
    
    return {
      nodes: this.selectedNodes,
      nodesConsidered: this.nodesConsidered,
      nodesCulled: this.nodesCulled,
    };
  }
  
  /**
   * Recursively select nodes for rendering
   */
  private selectNode(node: TerrainNode, cameraPos: vec3): void {
    this.nodesConsidered++;
    
    // Frustum culling
    if (!this.isInFrustum(node.bounds)) {
      this.nodesCulled++;
      return;
    }

    // Calculate distance from camera to node center (XZ plane)
    const distX = cameraPos[0] - node.center[0];
    const distZ = cameraPos[2] - node.center[2];
    const distanceXZ = Math.sqrt(distX * distX + distZ * distZ);

    // LOD selection: split if camera is close enough
    const lodThreshold = node.size * this.config.lodDistanceMultiplier;
    const shouldSplit = distanceXZ < lodThreshold && node.hasChildren();
    
    if (shouldSplit) {
      // Recurse into children
      for (const child of node.children!) {
        this.selectNode(child, cameraPos);
      }
    } else {
      // This node is selected for rendering
      // Calculate morph factor for smooth transitions
      node.morphFactor = this.calculateMorphFactor(node, distanceXZ);
      this.selectedNodes.push(node);
    }
  }
  
  /**
   * Calculate morph factor for smooth LOD transitions
   * Returns 0 at full resolution, 1 at transition to coarser LOD
   */
  private calculateMorphFactor(node: TerrainNode, distance: number): number {
    const { lodDistanceMultiplier, morphRegion } = this.config;
    
    const lodThreshold = node.size * lodDistanceMultiplier;
    const morphStart = lodThreshold * (1 - morphRegion);
    const morphEnd = lodThreshold;
    
    if (distance <= morphStart) {
      return 0;
    } else if (distance >= morphEnd) {
      return 1;
    } else {
      return (distance - morphStart) / (morphEnd - morphStart);
    }
  }
  
  /**
   * Extract frustum planes from view-projection matrix
   * Uses the Gribb/Hartmann method
   */
  private extractFrustumPlanes(vp: mat4): void {
    // Left plane
    this.frustumPlanes[0][0] = vp[3] + vp[0];
    this.frustumPlanes[0][1] = vp[7] + vp[4];
    this.frustumPlanes[0][2] = vp[11] + vp[8];
    this.frustumPlanes[0][3] = vp[15] + vp[12];
    
    // Right plane
    this.frustumPlanes[1][0] = vp[3] - vp[0];
    this.frustumPlanes[1][1] = vp[7] - vp[4];
    this.frustumPlanes[1][2] = vp[11] - vp[8];
    this.frustumPlanes[1][3] = vp[15] - vp[12];
    
    // Bottom plane
    this.frustumPlanes[2][0] = vp[3] + vp[1];
    this.frustumPlanes[2][1] = vp[7] + vp[5];
    this.frustumPlanes[2][2] = vp[11] + vp[9];
    this.frustumPlanes[2][3] = vp[15] + vp[13];
    
    // Top plane
    this.frustumPlanes[3][0] = vp[3] - vp[1];
    this.frustumPlanes[3][1] = vp[7] - vp[5];
    this.frustumPlanes[3][2] = vp[11] - vp[9];
    this.frustumPlanes[3][3] = vp[15] - vp[13];
    
    // Near plane
    this.frustumPlanes[4][0] = vp[3] + vp[2];
    this.frustumPlanes[4][1] = vp[7] + vp[6];
    this.frustumPlanes[4][2] = vp[11] + vp[10];
    this.frustumPlanes[4][3] = vp[15] + vp[14];
    
    // Far plane
    this.frustumPlanes[5][0] = vp[3] - vp[2];
    this.frustumPlanes[5][1] = vp[7] - vp[6];
    this.frustumPlanes[5][2] = vp[11] - vp[10];
    this.frustumPlanes[5][3] = vp[15] - vp[14];
    
    // Normalize planes
    for (const plane of this.frustumPlanes) {
      const len = Math.sqrt(plane[0] * plane[0] + plane[1] * plane[1] + plane[2] * plane[2]);
      if (len > 0) {
        plane[0] /= len;
        plane[1] /= len;
        plane[2] /= len;
        plane[3] /= len;
      }
    }
  }
  
  /**
   * Test if an AABB intersects the view frustum
   * Uses conservative culling - only rejects if ALL corners are outside one plane
   */
  private isInFrustum(bounds: AABB): boolean {
    // Expand bounds by a conservative margin to account for height variations
    // and prevent over-aggressive culling
    const margin = (bounds.max[0] - bounds.min[0]) * 0.1; // 10% of node size
    
    const minX = bounds.min[0] - margin;
    const minY = bounds.min[1] - margin;
    const minZ = bounds.min[2] - margin;
    const maxX = bounds.max[0] + margin;
    const maxY = bounds.max[1] + margin;
    const maxZ = bounds.max[2] + margin;
    
    for (const plane of this.frustumPlanes) {
      // Find the corner of the AABB that is farthest in the direction of the plane normal
      const px = plane[0] >= 0 ? maxX : minX;
      const py = plane[1] >= 0 ? maxY : minY;
      const pz = plane[2] >= 0 ? maxZ : minZ;
      
      // If this corner is behind the plane, the box is outside
      const dist = plane[0] * px + plane[1] * py + plane[2] * pz + plane[3];
      if (dist < 0) {
        return false;
      }
    }
    return true;
  }
  
  /**
   * Get the root node
   */
  getRoot(): TerrainNode | null {
    return this.root;
  }
  
  /**
   * Get the configuration
   */
  getConfig(): QuadtreeConfig {
    return this.config;
  }
  
  /**
   * Update configuration and rebuild tree
   */
  setConfig(config: Partial<QuadtreeConfig>): void {
    this.config = { ...this.config, ...config };
    this.buildTree();
  }
  
  /**
   * Get statistics about the quadtree
   */
  getStats(): { totalNodes: number; maxDepth: number } {
    let totalNodes = 0;
    let maxDepth = 0;
    
    const countNodes = (node: TerrainNode | null): void => {
      if (!node) return;
      totalNodes++;
      maxDepth = Math.max(maxDepth, node.lodLevel);
      if (node.children) {
        for (const child of node.children) {
          countNodes(child);
        }
      }
    };
    
    countNodes(this.root);
    return { totalNodes, maxDepth };
  }
}

/**
 * Render data for a selected terrain node
 * Passed to the shader for instanced rendering
 */
export interface NodeRenderData {
  /** World-space offset (X, Z) */
  offsetX: number;
  offsetZ: number;
  
  /** Scale factor (world units per grid vertex) */
  scale: number;
  
  /** LOD level */
  lodLevel: number;
  
  /** Morph factor (0-1) */
  morphFactor: number;
  
  /** Grid coordinates for heightmap sampling */
  gridX: number;
  gridZ: number;
}

/**
 * Convert selected nodes to render data
 */
export function nodesToRenderData(nodes: TerrainNode[], gridSize: number): NodeRenderData[] {
  return nodes.map(node => ({
    offsetX: node.center[0],
    offsetZ: node.center[2],
    scale: node.size / (gridSize - 1),
    lodLevel: node.lodLevel,
    morphFactor: node.morphFactor,
    gridX: node.gridX,
    gridZ: node.gridZ,
  }));
}
