/**
 * ClipmapGeometry - Generates ring meshes for clipmap terrain rendering
 * 
 * Each LOD level is a "ring" - a square grid with a smaller square cutout in the center.
 * The innermost ring (LOD 0) is a full square grid (no cutout).
 * Each successive ring has double the scale but same vertex count.
 */

export interface ClipmapRing {
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  scale: number;      // World units per vertex spacing
  gridSize: number;   // Number of vertices per side
}

export interface ClipmapConfig {
  /** Number of LOD rings (typically 4-6) */
  ringCount: number;
  /** Vertices per side for each ring (e.g., 64) */
  gridSize: number;
  /** Base scale in world units for innermost ring */
  baseScale: number;
}

/**
 * ClipmapGeometry manages the ring meshes used for clipmap terrain rendering.
 * 
 * Ring structure:
 * - Ring 0: Full grid (no cutout), highest detail, smallest area
 * - Ring 1+: Outer ring shape (grid with center cutout), each 2x scale of previous
 */
export class ClipmapGeometry {
  private gl: WebGL2RenderingContext;
  private rings: ClipmapRing[] = [];
  private config: ClipmapConfig;
  
  constructor(gl: WebGL2RenderingContext, config: ClipmapConfig) {
    this.gl = gl;
    this.config = config;
    this.generateRings();
  }
  
  private generateRings(): void {
    const { ringCount, gridSize, baseScale } = this.config;
    
    for (let i = 0; i < ringCount; i++) {
      const scale = baseScale * Math.pow(2, i);
      
      if (i === 0) {
        // Innermost ring: full square grid
        this.rings.push(this.createFullGrid(gridSize, scale));
      } else {
        // Outer rings: grid with center cutout
        this.rings.push(this.createRingGrid(gridSize, scale));
      }
    }
  }
  
  /**
   * Create a full square grid mesh (no cutout)
   * Used for the innermost LOD ring
   */
  private createFullGrid(gridSize: number, scale: number): ClipmapRing {
    const gl = this.gl;
    
    // Generate vertex positions
    // Grid is centered at origin, extends from -halfSize to +halfSize
    const halfSize = (gridSize - 1) * 0.5;
    const vertices: number[] = [];
    
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        // Position (XZ plane, Y will be sampled from heightmap)
        vertices.push(x - halfSize); // x
        vertices.push(0);            // y (placeholder)
        vertices.push(z - halfSize); // z
        
        // UV coordinates (0-1 range within this grid)
        vertices.push(x / (gridSize - 1));
        vertices.push(z / (gridSize - 1));
      }
    }
    
    // Generate indices for triangle strip / triangles
    const indices: number[] = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const topLeft = z * gridSize + x;
        const topRight = topLeft + 1;
        const bottomLeft = (z + 1) * gridSize + x;
        const bottomRight = bottomLeft + 1;
        
        // Two triangles per quad
        indices.push(topLeft, bottomLeft, topRight);
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }
    
    return this.createRingBuffers(vertices, indices, scale, gridSize);
  }
  
  /**
   * Create a ring grid mesh (outer ring with center cutout)
   * The inner cutout is 1/2 the size of the full grid
   */
  private createRingGrid(gridSize: number, scale: number): ClipmapRing {
    const gl = this.gl;
    
    // The ring extends from -halfSize to +halfSize
    // Inner cutout is from -quarterSize to +quarterSize
    const halfSize = (gridSize - 1) * 0.5;
    const quarterSize = halfSize * 0.5;
    
    const vertices: number[] = [];
    const vertexMap: Map<string, number> = new Map();
    
    // Helper to add vertex and get index
    const addVertex = (x: number, z: number): number => {
      const key = `${x},${z}`;
      if (vertexMap.has(key)) {
        return vertexMap.get(key)!;
      }
      
      const index = vertices.length / 5;
      vertices.push(x);     // x
      vertices.push(0);     // y (placeholder)
      vertices.push(z);     // z
      
      // UV: map from grid coords to 0-1
      vertices.push((x + halfSize) / (gridSize - 1));
      vertices.push((z + halfSize) / (gridSize - 1));
      
      vertexMap.set(key, index);
      return index;
    };
    
    const indices: number[] = [];
    
    // Generate triangles for the ring shape
    // We divide the ring into 4 L-shaped strips (top, bottom, left, right)
    
    // For simplicity, iterate over all cells and skip those in the center cutout
    const innerMin = -quarterSize;
    const innerMax = quarterSize;
    
    // Use a sparser representation for the ring
    // Full grid cells for outer area, skip inner area
    const step = 1;
    
    for (let gz = 0; gz < gridSize - 1; gz++) {
      for (let gx = 0; gx < gridSize - 1; gx++) {
        // Convert grid indices to positions
        const x = gx - halfSize;
        const z = gz - halfSize;
        
        // Check if this quad is entirely inside the cutout
        const x1 = x + step;
        const z1 = z + step;
        
        // Skip if fully inside inner region
        // Inner region is centered, from -quarterSize to +quarterSize
        if (x >= innerMin && x1 <= innerMax && z >= innerMin && z1 <= innerMax) {
          continue;
        }
        
        // Add quad
        const tl = addVertex(x, z);
        const tr = addVertex(x1, z);
        const bl = addVertex(x, z1);
        const br = addVertex(x1, z1);
        
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }
    
    return this.createRingBuffers(vertices, indices, scale, gridSize);
  }
  
  /**
   * Create WebGL buffers for a ring
   */
  private createRingBuffers(vertices: number[], indices: number[], scale: number, gridSize: number): ClipmapRing {
    const gl = this.gl;
    
    // Create VAO
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    
    // Vertex buffer
    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    
    // Position attribute (location 0): 3 floats
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 5 * 4, 0);
    
    // UV attribute (location 2): 2 floats - matches existing terrain shader
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 5 * 4, 3 * 4);
    
    // Index buffer
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    
    gl.bindVertexArray(null);
    
    return {
      vao,
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
      scale,
      gridSize,
    };
  }
  
  /**
   * Get all clipmap rings
   */
  getRings(): ClipmapRing[] {
    return this.rings;
  }
  
  /**
   * Get a specific ring by LOD level
   */
  getRing(lodLevel: number): ClipmapRing | null {
    return this.rings[lodLevel] || null;
  }
  
  /**
   * Get the number of rings
   */
  getRingCount(): number {
    return this.rings.length;
  }
  
  /**
   * Get the configuration
   */
  getConfig(): ClipmapConfig {
    return this.config;
  }
  
  /**
   * Calculate the total coverage radius for a given number of rings
   */
  getCoverageRadius(): number {
    const { ringCount, gridSize, baseScale } = this.config;
    let radius = 0;
    
    for (let i = 0; i < ringCount; i++) {
      const scale = baseScale * Math.pow(2, i);
      radius = ((gridSize - 1) * 0.5) * scale;
    }
    
    return radius;
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    const gl = this.gl;
    
    for (const ring of this.rings) {
      gl.deleteVertexArray(ring.vao);
      gl.deleteBuffer(ring.vertexBuffer);
      gl.deleteBuffer(ring.indexBuffer);
    }
    
    this.rings = [];
  }
}

/**
 * Calculate camera-snapped ring offset
 * Snaps camera position to the ring's grid to prevent swimming artifacts
 */
export function snapToGrid(cameraX: number, cameraZ: number, gridScale: number): [number, number] {
  return [
    Math.floor(cameraX / gridScale) * gridScale,
    Math.floor(cameraZ / gridScale) * gridScale,
  ];
}
