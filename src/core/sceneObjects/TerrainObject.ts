/**
 * TerrainObject - Procedural terrain with noise generation and erosion simulation
 */

import { mat4, vec3 } from 'gl-matrix';
import { RenderableObject } from './RenderableObject';
import type {
  TerrainParams,
  AABB,
  GPUMesh,
  SerializedTerrainObject,
} from './types';
import { createDefaultTerrainParams } from './types';

/**
 * Progress callback for terrain generation
 */
export interface TerrainGenerationProgress {
  stage: 'init' | 'noise' | 'hydraulic' | 'thermal' | 'mesh' | 'upload' | 'complete';
  progress: number; // 0-1
  message: string;
}

export type TerrainProgressCallback = (progress: TerrainGenerationProgress) => void;

/**
 * Terrain mesh data for GPU upload
 */
export interface TerrainMeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Per-vertex: [slope, erosion] */
  attributes: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

/**
 * TerrainObject - A procedurally generated terrain scene object
 * 
 * Features:
 * - Fractal noise heightmap generation (fBm + ridged)
 * - Hydraulic erosion simulation
 * - Thermal erosion simulation
 * - Height/slope/erosion-based material blending
 */
export class TerrainObject extends RenderableObject {
  public readonly objectType = 'terrain' as const;
  
  /** Terrain generation parameters */
  public params: TerrainParams;
  
  /** Generated heightmap data */
  private heightmap: Float32Array | null = null;
  
  /** Erosion amount per cell (for material blending) */
  private erosionMap: Float32Array | null = null;
  
  /** GPU mesh reference */
  private terrainMesh: TerrainMeshData | null = null;
  
  /** WebGL context reference */
  private gl: WebGL2RenderingContext | null = null;
  
  /** GPU buffers */
  private vao: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private normalBuffer: WebGLBuffer | null = null;
  private uvBuffer: WebGLBuffer | null = null;
  private attributeBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  
  /** Heightmap texture for LOD displacement */
  private heightmapTexture: WebGLTexture | null = null;
  private erosionTexture: WebGLTexture | null = null;
  
  /** LOD base grid meshes: resolution -> {vao, indexBuffer, indexCount} */
  private lodMeshes = new Map<number, {
    vao: WebGLVertexArrayObject;
    posBuffer: WebGLBuffer;
    uvBuffer: WebGLBuffer;
    indexBuffer: WebGLBuffer;
    indexCount: number;
  }>();
  
  /** LOD configuration */
  private static readonly LOD_RESOLUTIONS = [16, 32, 64, 128];
  private static readonly LOD_DISTANCES = [50, 25, 10, 0]; // Camera distance thresholds
  
  /** Current LOD level (0=lowest, 3=highest) */
  private currentLOD = 3;
  
  /** Whether clipmap rendering is enabled (camera-centered LOD rings) */
  public clipmapEnabled = false;
  
  /** @deprecated Use clipmapEnabled instead */
  public get lodEnabled(): boolean {
    return this.clipmapEnabled;
  }
  public set lodEnabled(value: boolean) {
    this.clipmapEnabled = value;
  }
  
  /** Whether terrain needs regeneration */
  private needsRegeneration: boolean = true;
  
  /** Whether terrain has been generated at least once */
  private isGenerated: boolean = false;
  
  constructor(
    name: string = 'Terrain',
    params?: Partial<TerrainParams>,
    gl?: WebGL2RenderingContext
  ) {
    super(name);
    this.params = { ...createDefaultTerrainParams(), ...params };
    this.gl = gl || null;
    
    // Set default terrain bounds based on worldSize
    this.updateBounds();
  }
  
  /**
   * Initialize with WebGL context
   */
  initialize(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.createGPUResources();
  }
  
  /**
   * Regenerate terrain based on current parameters
   * @param onProgress - Optional progress callback
   */
  async regenerate(onProgress?: TerrainProgressCallback): Promise<void> {
    if (!this.gl) {
      throw new Error('TerrainObject not initialized with WebGL context');
    }
    
    const { resolution, worldSize, noise, erosion } = this.params;
    
    // Stage 1: Initialization
    onProgress?.({
      stage: 'init',
      progress: 0,
      message: 'Initializing heightmap...',
    });
    
    this.heightmap = new Float32Array(resolution * resolution);
    this.erosionMap = new Float32Array(resolution * resolution);
    
    // Allow UI update
    await this.yieldToUI();
    
    // Stage 2: Noise generation
    onProgress?.({
      stage: 'noise',
      progress: 0.1,
      message: 'Generating heightmap...',
    });
    
    this.generateHeightmap();
    await this.yieldToUI();
    
    // Stage 3: Hydraulic erosion
    if (erosion.enabled) {
      onProgress?.({
        stage: 'hydraulic',
        progress: 0.3,
        message: `Simulating erosion (${erosion.iterations.toLocaleString()} droplets)...`,
      });
      
      await this.applyHydraulicErosion(onProgress);
    }
    
    // Stage 4: Thermal erosion
    if (erosion.thermalEnabled) {
      onProgress?.({
        stage: 'thermal',
        progress: 0.7,
        message: 'Applying thermal erosion...',
      });
      
      this.applyThermalErosion();
      await this.yieldToUI();
    }
    
    // Stage 5: Mesh generation
    onProgress?.({
      stage: 'mesh',
      progress: 0.85,
      message: 'Generating mesh...',
    });
    
    this.terrainMesh = this.generateMesh();
    await this.yieldToUI();
    
    // Stage 6: GPU upload
    onProgress?.({
      stage: 'upload',
      progress: 0.95,
      message: 'Uploading to GPU...',
    });
    
    this.uploadToGPU();
    this.updateBounds();
    
    // Initialize LOD system for displacement-based rendering
    this.createLODMeshes();
    this.uploadHeightmapTexture();
    
    this.needsRegeneration = false;
    this.isGenerated = true;
    
    onProgress?.({
      stage: 'complete',
      progress: 1,
      message: 'Complete',
    });
  }
  
  /**
   * Generate heightmap using fractal noise with domain warping
   */
  private generateHeightmap(): void {
    if (!this.heightmap) return;
    
    const { resolution, noise } = this.params;
    const { scale, octaves, lacunarity, persistence, heightScale, ridgeWeight, offset, seed,
            warpStrength, warpScale, warpOctaves, rotateOctaves, octaveRotation } = noise;
    
    // Simple seeded random for noise permutation
    const rng = this.createSeededRandom(seed);
    const perm = this.generatePermutation(rng);
    
    // Create a separate permutation for warping noise (different pattern)
    const warpRng = this.createSeededRandom(seed + 7919); // Different prime offset
    const warpPerm = this.generatePermutation(warpRng);
    
    // Precompute rotation angles for each octave (in radians)
    const octaveAngles: number[] = [];
    if (rotateOctaves) {
      const baseAngle = (octaveRotation * Math.PI) / 180;
      for (let i = 0; i < octaves; i++) {
        octaveAngles.push(baseAngle * i);
      }
    }
    
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        let nx = (x / resolution + offset[0]) * scale;
        let ny = (y / resolution + offset[1]) * scale;
        
        // Apply domain warping
        if (warpStrength > 0) {
          const warped = this.domainWarp(nx, ny, warpStrength, warpScale, warpOctaves, warpPerm);
          nx = warped.x;
          ny = warped.y;
        }
        
        // Generate fBm and ridged noise with optional octave rotation
        const fbmValue = rotateOctaves
          ? this.fbmRotated(nx, ny, octaves, lacunarity, persistence, perm, octaveAngles)
          : this.fbm(nx, ny, octaves, lacunarity, persistence, perm);
        
        const ridgedValue = rotateOctaves
          ? this.ridgedRotated(nx, ny, octaves, lacunarity, persistence, perm, octaveAngles)
          : this.ridged(nx, ny, octaves, lacunarity, persistence, perm);
        
        // Blend between fBm and ridged
        const height = fbmValue * (1 - ridgeWeight) + ridgedValue * ridgeWeight;
        
        this.heightmap[y * resolution + x] = height * heightScale;
      }
    }
  }
  
  /**
   * Apply domain warping to coordinates
   * This distorts the input coordinates using noise to break up repetitive patterns
   */
  private domainWarp(
    x: number, y: number,
    strength: number,
    warpScale: number,
    warpOctaves: number,
    perm: Uint8Array
  ): { x: number; y: number } {
    // Sample noise at offset positions to get warp vectors
    // Using different offsets ensures X and Y warps are independent
    const offsetX1 = 5.2;
    const offsetY1 = 1.3;
    const offsetX2 = 9.7;
    const offsetY2 = 2.8;
    
    let warpX = 0;
    let warpY = 0;
    
    // Multi-octave warping for more organic distortion
    let amplitude = 1;
    let frequency = 1;
    let maxAmp = 0;
    
    for (let i = 0; i < warpOctaves; i++) {
      warpX += amplitude * this.noise2D(
        (x + offsetX1) * warpScale * frequency,
        (y + offsetY1) * warpScale * frequency,
        perm
      );
      warpY += amplitude * this.noise2D(
        (x + offsetX2) * warpScale * frequency,
        (y + offsetY2) * warpScale * frequency,
        perm
      );
      maxAmp += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    
    // Normalize and apply strength
    warpX = (warpX / maxAmp) * strength;
    warpY = (warpY / maxAmp) * strength;
    
    return {
      x: x + warpX,
      y: y + warpY,
    };
  }
  
  /**
   * Apply hydraulic erosion simulation
   */
  private async applyHydraulicErosion(onProgress?: TerrainProgressCallback): Promise<void> {
    if (!this.heightmap || !this.erosionMap) return;
    
    const { resolution } = this.params;
    const { iterations, maxDropletLifetime, inertia, sedimentCapacity, 
            depositSpeed, erodeSpeed, evaporation, gravity, erosionRadius, minSlope } = this.params.erosion;
    
    // Create seeded RNG for droplet positions
    const rng = this.createSeededRandom(this.params.noise.seed + 1);
    
    // Process droplets in batches for UI responsiveness
    const batchSize = 5000;
    
    for (let i = 0; i < iterations; i++) {
      // Spawn droplet at random position
      const startX = rng() * (resolution - 1);
      const startY = rng() * (resolution - 1);
      
      this.simulateDroplet(
        startX, startY,
        maxDropletLifetime,
        inertia,
        sedimentCapacity,
        depositSpeed,
        erodeSpeed,
        evaporation,
        gravity,
        erosionRadius,
        minSlope
      );
      
      // Update progress periodically
      if (i % batchSize === 0) {
        const progress = 0.3 + (i / iterations) * 0.4;
        onProgress?.({
          stage: 'hydraulic',
          progress,
          message: `Simulating erosion... ${Math.round((i / iterations) * 100)}%`,
        });
        await this.yieldToUI();
      }
    }
  }
  
  /**
   * Simulate a single water droplet
   */
  private simulateDroplet(
    startX: number, startY: number,
    maxLifetime: number,
    inertia: number,
    sedimentCapacity: number,
    depositSpeed: number,
    erodeSpeed: number,
    evaporation: number,
    gravity: number,
    erosionRadius: number,
    minSlope: number
  ): void {
    if (!this.heightmap || !this.erosionMap) return;
    
    const { resolution } = this.params;
    
    let x = startX;
    let y = startY;
    let dirX = 0;
    let dirY = 0;
    let velocity = 1;
    let water = 1;
    let sediment = 0;
    
    for (let step = 0; step < maxLifetime; step++) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      
      // Check bounds
      if (xi < 1 || xi >= resolution - 2 || yi < 1 || yi >= resolution - 2) break;
      
      // Calculate gradient
      const gradient = this.calculateGradient(x, y);
      
      // Update direction with inertia
      dirX = dirX * inertia - gradient.x * (1 - inertia);
      dirY = dirY * inertia - gradient.y * (1 - inertia);
      
      // Normalize direction
      const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
      if (dirLen < 0.0001) break;
      dirX /= dirLen;
      dirY /= dirLen;
      
      // Calculate new position
      const newX = x + dirX;
      const newY = y + dirY;
      
      // Calculate height change
      const oldHeight = this.sampleHeightBilinear(x, y);
      const newHeight = this.sampleHeightBilinear(newX, newY);
      const deltaHeight = newHeight - oldHeight;
      
      // Calculate sediment capacity
      const capacity = Math.max(-deltaHeight, minSlope) * velocity * water * sedimentCapacity;
      
      // Erode or deposit
      if (sediment > capacity || deltaHeight > 0) {
        // Deposit sediment
        const depositAmount = deltaHeight > 0
          ? Math.min(deltaHeight, sediment)
          : (sediment - capacity) * depositSpeed;
        
        sediment -= depositAmount;
        this.depositSediment(x, y, depositAmount);
      } else {
        // Erode terrain
        const erodeAmount = Math.min(
          (capacity - sediment) * erodeSpeed,
          -deltaHeight
        );
        
        sediment += erodeAmount;
        this.erodeTerrain(x, y, erodeAmount, erosionRadius);
      }
      
      // Update droplet state
      const newVelocitySq = velocity * velocity + deltaHeight * gravity;
      velocity = Math.sqrt(Math.max(0, newVelocitySq)); // Protect against negative sqrt
      water *= (1 - evaporation);
      x = newX;
      y = newY;
      
      if (water < 0.001) break;
    }
  }
  
  /**
   * Apply thermal erosion simulation
   */
  private applyThermalErosion(): void {
    if (!this.heightmap) return;
    
    const { resolution } = this.params;
    const { thermalIterations, talusAngle } = this.params.erosion;
    
    for (let iter = 0; iter < thermalIterations; iter++) {
      for (let y = 1; y < resolution - 1; y++) {
        for (let x = 1; x < resolution - 1; x++) {
          const idx = y * resolution + x;
          const h = this.heightmap[idx];
          
          // Find steepest downhill neighbor
          let maxDelta = 0;
          let targetIdx = -1;
          
          const neighbors = [
            idx - 1,              // left
            idx + 1,              // right
            idx - resolution,     // up
            idx + resolution,     // down
          ];
          
          for (const ni of neighbors) {
            const delta = h - this.heightmap[ni];
            if (delta > maxDelta) {
              maxDelta = delta;
              targetIdx = ni;
            }
          }
          
          // Transfer material if slope exceeds talus angle
          if (maxDelta > talusAngle && targetIdx >= 0) {
            const transfer = (maxDelta - talusAngle) * 0.5;
            this.heightmap[idx] -= transfer;
            this.heightmap[targetIdx] += transfer;
          }
        }
      }
    }
  }
  
  /**
   * Generate mesh from heightmap
   */
  private generateMesh(): TerrainMeshData {
    const { resolution, worldSize } = this.params;
    const heightmap = this.heightmap!;
    const erosionMap = this.erosionMap!;
    
    const vertexCount = resolution * resolution;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const attributes = new Float32Array(vertexCount * 2); // slope, erosion
    
    // Generate vertices
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const i = y * resolution + x;
        const worldX = (x / (resolution - 1) - 0.5) * worldSize;
        const worldZ = (y / (resolution - 1) - 0.5) * worldSize;
        const worldY = heightmap[i];
        
        positions[i * 3 + 0] = worldX;
        positions[i * 3 + 1] = worldY;
        positions[i * 3 + 2] = worldZ;
        
        uvs[i * 2 + 0] = x / (resolution - 1);
        uvs[i * 2 + 1] = y / (resolution - 1);
      }
    }
    
    // Calculate normals and slope
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const i = y * resolution + x;
        
        const hL = x > 0 ? heightmap[y * resolution + (x - 1)] : heightmap[i];
        const hR = x < resolution - 1 ? heightmap[y * resolution + (x + 1)] : heightmap[i];
        const hD = y > 0 ? heightmap[(y - 1) * resolution + x] : heightmap[i];
        const hU = y < resolution - 1 ? heightmap[(y + 1) * resolution + x] : heightmap[i];
        
        const dx = (hR - hL) * resolution / worldSize;
        const dy = (hU - hD) * resolution / worldSize;
        
        // Normal = normalize(-dx, 1, -dy)
        const len = Math.sqrt(dx * dx + 1 + dy * dy);
        normals[i * 3 + 0] = -dx / len;
        normals[i * 3 + 1] = 1 / len;
        normals[i * 3 + 2] = -dy / len;
        
        // Slope = 1 - normal.y (0 = flat, 1 = vertical)
        attributes[i * 2 + 0] = 1 - normals[i * 3 + 1];
        attributes[i * 2 + 1] = erosionMap[i];
      }
    }
    
    // Generate indices
    const indexCount = (resolution - 1) * (resolution - 1) * 6;
    const indices = new Uint32Array(indexCount);
    let idx = 0;
    
    for (let y = 0; y < resolution - 1; y++) {
      for (let x = 0; x < resolution - 1; x++) {
        const tl = y * resolution + x;
        const tr = tl + 1;
        const bl = tl + resolution;
        const br = bl + 1;
        
        indices[idx++] = tl;
        indices[idx++] = bl;
        indices[idx++] = tr;
        indices[idx++] = tr;
        indices[idx++] = bl;
        indices[idx++] = br;
      }
    }
    
    return { positions, normals, uvs, attributes, indices, vertexCount, indexCount };
  }
  
  /**
   * Create GPU resources
   */
  private createGPUResources(): void {
    if (!this.gl) return;
    const gl = this.gl;
    
    // Create VAO
    this.vao = gl.createVertexArray();
    
    // Create buffers
    this.positionBuffer = gl.createBuffer();
    this.normalBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    this.attributeBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
  }
  
  /**
   * Upload mesh data to GPU
   */
  private uploadToGPU(): void {
    if (!this.gl || !this.terrainMesh) {
      console.error('[TerrainObject] Cannot upload: missing GL context or mesh data');
      return;
    }
    
    // Always recreate GPU resources to ensure correct buffer sizes
    this.deleteGPUResources();
    this.createGPUResources();
    
    if (!this.vao) {
      console.error('[TerrainObject] Failed to create VAO');
      return;
    }
    
    const gl = this.gl;
    const mesh = this.terrainMesh;
    
    gl.bindVertexArray(this.vao);
    
    // Position buffer (location 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    
    // Normal buffer (location 1)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    
    // UV buffer (location 2)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    
    // Attributes buffer (location 3) - slope, erosion
    gl.bindBuffer(gl.ARRAY_BUFFER, this.attributeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.attributes, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    
    // Index buffer
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    
    gl.bindVertexArray(null);
  }
  
  /**
   * Delete GPU resources (for recreation on resize)
   */
  private deleteGPUResources(): void {
    if (!this.gl) return;
    const gl = this.gl;
    
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
    if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
    if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
    if (this.attributeBuffer) gl.deleteBuffer(this.attributeBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    
    this.vao = null;
    this.positionBuffer = null;
    this.normalBuffer = null;
    this.uvBuffer = null;
    this.attributeBuffer = null;
    this.indexBuffer = null;
  }
  
  /**
   * Update local bounds based on terrain parameters
   */
  private updateBounds(): void {
    const { worldSize } = this.params;
    const halfSize = worldSize / 2;
    const maxHeight = this.params.noise.heightScale * 1.5; // Some margin
    
    this.localBounds = {
      min: new Float32Array([-halfSize, 0, -halfSize]),
      max: new Float32Array([halfSize, maxHeight, halfSize]),
    };
  }
  
  // ========================================
  // Noise utilities
  // ========================================
  
  /**
   * Create a seeded pseudo-random number generator
   */
  private createSeededRandom(seed: number): () => number {
    // Simple LCG PRNG
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }
  
  /**
   * Generate permutation table for noise
   */
  private generatePermutation(rng: () => number): Uint8Array {
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    
    for (let i = 0; i < 256; i++) p[i] = i;
    
    // Fisher-Yates shuffle
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    
    // Double for wrapping
    for (let i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
    }
    
    return perm;
  }
  
  /**
   * 2D Simplex noise
   */
  private noise2D(x: number, y: number, perm: Uint8Array): number {
    // Simplex noise implementation
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    
    const t = (i + j) * G2;
    const X0 = i - t;
    const Y0 = j - t;
    const x0 = x - X0;
    const y0 = y - Y0;
    
    let i1: number, j1: number;
    if (x0 > y0) {
      i1 = 1; j1 = 0;
    } else {
      i1 = 0; j1 = 1;
    }
    
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    
    const ii = i & 255;
    const jj = j & 255;
    
    const gi0 = perm[ii + perm[jj]] % 12;
    const gi1 = perm[ii + i1 + perm[jj + j1]] % 12;
    const gi2 = perm[ii + 1 + perm[jj + 1]] % 12;
    
    const grad3 = [
      [1, 1], [-1, 1], [1, -1], [-1, -1],
      [1, 0], [-1, 0], [0, 1], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    
    let n0 = 0, n1 = 0, n2 = 0;
    
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      t0 *= t0;
      n0 = t0 * t0 * (grad3[gi0][0] * x0 + grad3[gi0][1] * y0);
    }
    
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      t1 *= t1;
      n1 = t1 * t1 * (grad3[gi1][0] * x1 + grad3[gi1][1] * y1);
    }
    
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      t2 *= t2;
      n2 = t2 * t2 * (grad3[gi2][0] * x2 + grad3[gi2][1] * y2);
    }
    
    return 70 * (n0 + n1 + n2);
  }
  
  /**
   * Fractal Brownian Motion
   */
  private fbm(
    x: number, y: number,
    octaves: number,
    lacunarity: number,
    persistence: number,
    perm: Uint8Array
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    
    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise2D(x * frequency, y * frequency, perm);
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    
    return (value / maxValue + 1) / 2; // Normalize to [0, 1]
  }
  
  /**
   * Ridged multifractal noise
   */
  private ridged(
    x: number, y: number,
    octaves: number,
    lacunarity: number,
    persistence: number,
    perm: Uint8Array
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let weight = 1;
    
    for (let i = 0; i < octaves; i++) {
      let signal = this.noise2D(x * frequency, y * frequency, perm);
      signal = 1 - Math.abs(signal);
      signal = signal * signal;
      signal *= weight;
      
      weight = Math.min(1, Math.max(0, signal * 2));
      value += signal * amplitude;
      
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    
    return value;
  }
  
  /**
   * Fractal Brownian Motion with per-octave rotation
   * Rotates sample coordinates for each octave to break axis-aligned patterns
   */
  private fbmRotated(
    x: number, y: number,
    octaves: number,
    lacunarity: number,
    persistence: number,
    perm: Uint8Array,
    octaveAngles: number[]
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    
    for (let i = 0; i < octaves; i++) {
      // Rotate coordinates for this octave
      const angle = octaveAngles[i] || 0;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      
      value += amplitude * this.noise2D(rx * frequency, ry * frequency, perm);
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    
    return (value / maxValue + 1) / 2; // Normalize to [0, 1]
  }
  
  /**
   * Ridged multifractal noise with per-octave rotation
   * Rotates sample coordinates for each octave to break axis-aligned ridge patterns
   */
  private ridgedRotated(
    x: number, y: number,
    octaves: number,
    lacunarity: number,
    persistence: number,
    perm: Uint8Array,
    octaveAngles: number[]
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let weight = 1;
    
    for (let i = 0; i < octaves; i++) {
      // Rotate coordinates for this octave
      const angle = octaveAngles[i] || 0;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const rx = x * cos - y * sin;
      const ry = x * sin + y * cos;
      
      let signal = this.noise2D(rx * frequency, ry * frequency, perm);
      signal = 1 - Math.abs(signal);
      signal = signal * signal;
      signal *= weight;
      
      weight = Math.min(1, Math.max(0, signal * 2));
      value += signal * amplitude;
      
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    
    return value;
  }
  
  // ========================================
  // Erosion utilities
  // ========================================
  
  /**
   * Calculate gradient at position using bilinear interpolation
   */
  private calculateGradient(x: number, y: number): { x: number; y: number } {
    const { resolution } = this.params;
    const heightmap = this.heightmap!;
    
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    
    const idx = yi * resolution + xi;
    
    const h00 = heightmap[idx];
    const h10 = heightmap[idx + 1];
    const h01 = heightmap[idx + resolution];
    const h11 = heightmap[idx + resolution + 1];
    
    // Gradient in x direction
    const gradX = (h10 - h00) * (1 - fy) + (h11 - h01) * fy;
    // Gradient in y direction
    const gradY = (h01 - h00) * (1 - fx) + (h11 - h10) * fx;
    
    return { x: gradX, y: gradY };
  }
  
  /**
   * Sample height with bilinear interpolation
   */
  private sampleHeightBilinear(x: number, y: number): number {
    const { resolution } = this.params;
    const heightmap = this.heightmap!;
    
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    
    const idx = yi * resolution + xi;
    
    const h00 = heightmap[idx];
    const h10 = heightmap[idx + 1];
    const h01 = heightmap[idx + resolution];
    const h11 = heightmap[idx + resolution + 1];
    
    return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) +
           h01 * (1 - fx) * fy + h11 * fx * fy;
  }
  
  /**
   * Deposit sediment at position
   */
  private depositSediment(x: number, y: number, amount: number): void {
    const { resolution } = this.params;
    const heightmap = this.heightmap!;
    
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    
    const idx = yi * resolution + xi;
    
    // Protect against NaN propagation
    if (!isFinite(amount)) return;
    
    // Deposit with bilinear weights
    heightmap[idx] += amount * (1 - fx) * (1 - fy);
    heightmap[idx + 1] += amount * fx * (1 - fy);
    heightmap[idx + resolution] += amount * (1 - fx) * fy;
    heightmap[idx + resolution + 1] += amount * fx * fy;
  }
  
  /**
   * Erode terrain at position with brush radius
   */
  private erodeTerrain(
    x: number, y: number,
    amount: number,
    radius: number
  ): void {
    const { resolution } = this.params;
    const heightmap = this.heightmap!;
    const erosionMap = this.erosionMap!;
    
    const xi = Math.round(x);
    const yi = Math.round(y);
    
    // Calculate weights for erosion brush
    let totalWeight = 0;
    const weights: { i: number; w: number }[] = [];
    
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = xi + dx;
        const ny = yi + dy;
        
        if (nx < 0 || nx >= resolution || ny < 0 || ny >= resolution) continue;
        
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        
        const w = Math.max(0, 1 - dist / radius);
        weights.push({ i: ny * resolution + nx, w });
        totalWeight += w;
      }
    }
    
    // Apply erosion with weights
    if (totalWeight === 0 || !isFinite(amount)) return;
    
    for (const { i, w } of weights) {
      const delta = amount * w / totalWeight;
      if (isFinite(delta)) {
        heightmap[i] -= delta;
        erosionMap[i] += delta;
      }
    }
  }
  
  // ========================================
  // Utility methods
  // ========================================
  
  /**
   * Yield to UI for responsiveness during long operations
   */
  private yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }
  
  // ========================================
  // LOD System
  // ========================================
  
  /**
   * Create LOD grid meshes at multiple resolutions
   */
  createLODMeshes(): void {
    if (!this.gl) return;
    const gl = this.gl;
    const { worldSize } = this.params;
    
    // Clean up existing LOD meshes
    for (const mesh of this.lodMeshes.values()) {
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.posBuffer);
      gl.deleteBuffer(mesh.uvBuffer);
      gl.deleteBuffer(mesh.indexBuffer);
    }
    this.lodMeshes.clear();
    
    // Create meshes at each LOD resolution
    for (const res of TerrainObject.LOD_RESOLUTIONS) {
      const mesh = this.createGridMesh(res, worldSize);
      this.lodMeshes.set(res, mesh);
    }
  }
  
  /**
   * Create a flat grid mesh at given resolution
   */
  private createGridMesh(resolution: number, worldSize: number): {
    vao: WebGLVertexArrayObject;
    posBuffer: WebGLBuffer;
    uvBuffer: WebGLBuffer;
    indexBuffer: WebGLBuffer;
    indexCount: number;
  } {
    const gl = this.gl!;
    const halfSize = worldSize / 2;
    
    // Generate vertex data
    const vertexCount = resolution * resolution;
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const i = z * resolution + x;
        const u = x / (resolution - 1);
        const v = z / (resolution - 1);
        
        // XZ position (Y will be displaced in shader)
        positions[i * 3 + 0] = (u - 0.5) * worldSize;
        positions[i * 3 + 1] = 0; // Y=0, displaced in vertex shader
        positions[i * 3 + 2] = (v - 0.5) * worldSize;
        
        uvs[i * 2 + 0] = u;
        uvs[i * 2 + 1] = v;
      }
    }
    
    // Generate indices
    const indexCount = (resolution - 1) * (resolution - 1) * 6;
    const indices = new Uint32Array(indexCount);
    let idx = 0;
    
    for (let z = 0; z < resolution - 1; z++) {
      for (let x = 0; x < resolution - 1; x++) {
        const tl = z * resolution + x;
        const tr = tl + 1;
        const bl = tl + resolution;
        const br = bl + 1;
        
        indices[idx++] = tl;
        indices[idx++] = bl;
        indices[idx++] = tr;
        indices[idx++] = tr;
        indices[idx++] = bl;
        indices[idx++] = br;
      }
    }
    
    // Create VAO
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    
    // Position buffer (location 0)
    const posBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    
    // UV buffer (location 2)
    const uvBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
    
    // Index buffer
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    
    gl.bindVertexArray(null);
    
    return { vao, posBuffer, uvBuffer, indexBuffer, indexCount };
  }
  
  /**
   * Upload heightmap and erosion data as GPU textures
   */
  uploadHeightmapTexture(): void {
    if (!this.gl || !this.heightmap || !this.erosionMap) return;
    const gl = this.gl;
    const { resolution } = this.params;
    
    // Try to enable linear filtering for float textures
    // Without this extension, LINEAR filtering on R32F returns 0
    const floatLinearExt = gl.getExtension('OES_texture_float_linear');
    const filterMode = floatLinearExt ? gl.LINEAR : gl.NEAREST;
    
    if (!floatLinearExt) {
      console.warn('[TerrainObject] OES_texture_float_linear not available, using NEAREST filtering for heightmap');
    }
    
    // Create heightmap texture (R32F)
    if (this.heightmapTexture) {
      gl.deleteTexture(this.heightmapTexture);
    }
    this.heightmapTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.heightmapTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      resolution, resolution, 0,
      gl.RED, gl.FLOAT, this.heightmap
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create erosion texture (R32F)
    if (this.erosionTexture) {
      gl.deleteTexture(this.erosionTexture);
    }
    this.erosionTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.erosionTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.R32F,
      resolution, resolution, 0,
      gl.RED, gl.FLOAT, this.erosionMap
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filterMode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  
  /**
   * Update LOD based on camera distance
   */
  updateLOD(cameraPos: Float32Array | number[]): void {
    const dx = cameraPos[0] - this.position[0];
    const dy = cameraPos[1] - this.position[1];
    const dz = cameraPos[2] - this.position[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    // Select LOD based on distance
    for (let i = 0; i < TerrainObject.LOD_DISTANCES.length; i++) {
      if (distance >= TerrainObject.LOD_DISTANCES[i]) {
        this.currentLOD = i;
        break;
      }
    }
  }
  
  /**
   * Get LOD mesh for current detail level
   */
  getLODMesh(): { vao: WebGLVertexArrayObject; indexCount: number } | null {
    const resolution = TerrainObject.LOD_RESOLUTIONS[this.currentLOD];
    const mesh = this.lodMeshes.get(resolution);
    if (!mesh) return null;
    return { vao: mesh.vao, indexCount: mesh.indexCount };
  }
  
  /**
   * Get heightmap texture for displacement
   */
  getHeightmapTexture(): WebGLTexture | null {
    return this.heightmapTexture;
  }
  
  /**
   * Get erosion texture for material blending
   */
  getErosionTexture(): WebGLTexture | null {
    return this.erosionTexture;
  }
  
  /**
   * Get current LOD level (0=lowest, 3=highest)
   */
  getCurrentLOD(): number {
    return this.currentLOD;
  }
  
  /**
   * Check if LOD mode is enabled
   */
  hasLODMeshes(): boolean {
    return this.lodMeshes.size > 0 && this.heightmapTexture !== null;
  }
  
  /**
   * Get the raw heightmap data
   */
  getHeightmap(): Float32Array | null {
    return this.heightmap;
  }
  
  /**
   * Get the erosion map data
   */
  getErosionMap(): Float32Array | null {
    return this.erosionMap;
  }
  
  /**
   * Check if terrain has been generated
   */
  hasGenerated(): boolean {
    return this.isGenerated;
  }
  
  /**
   * Get the VAO for rendering
   */
  getVAO(): WebGLVertexArrayObject | null {
    return this.vao;
  }
  
  /**
   * Get index count for rendering
   */
  getIndexCount(): number {
    return this.terrainMesh?.indexCount ?? 0;
  }
  
  /**
   * Get material parameters for shader
   */
  getMaterialParams(): TerrainParams['material'] {
    return this.params.material;
  }
  
  /**
   * Sample height at world position
   */
  sampleHeightAtWorld(worldX: number, worldZ: number): number {
    if (!this.heightmap) return 0;
    
    const { resolution, worldSize } = this.params;
    const halfSize = worldSize / 2;
    
    // Convert world position to heightmap coordinates
    const hx = ((worldX + halfSize) / worldSize) * (resolution - 1);
    const hy = ((worldZ + halfSize) / worldSize) * (resolution - 1);
    
    // Clamp to valid range
    const x = Math.max(0, Math.min(resolution - 2, hx));
    const y = Math.max(0, Math.min(resolution - 2, hy));
    
    return this.sampleHeightBilinear(x, y);
  }
  
  /**
   * Serialize terrain for save/load
   */
  serialize(): SerializedTerrainObject {
    return {
      type: 'terrain',
      id: this.id,
      name: this.name,
      position: [this.position[0], this.position[1], this.position[2]],
      rotation: [0, 0, 0], // Euler for compatibility
      rotationQuat: [
        this.rotation[0],
        this.rotation[1],
        this.rotation[2],
        this.rotation[3],
      ],
      scale: [this.scale[0], this.scale[1], this.scale[2]],
      visible: this.visible,
      groupId: this.groupId,
      terrainParams: this.params,
    };
  }
  
  /**
   * Deserialize terrain from saved data
   */
  static deserialize(
    data: SerializedTerrainObject,
    gl: WebGL2RenderingContext
  ): TerrainObject {
    const terrain = new TerrainObject(data.name, data.terrainParams, gl);
    
    if (data.id) (terrain as any)._id = data.id;
    terrain.position = new Float32Array(data.position);
    
    if (data.rotationQuat) {
      terrain.rotation = new Float32Array(data.rotationQuat);
    }
    
    terrain.scale = new Float32Array(data.scale);
    terrain.visible = data.visible ?? true;
    terrain.groupId = data.groupId ?? null;
    
    return terrain;
  }
  
  /**
   * Clean up GPU resources
   */
  override destroy(): void {
    if (this.gl) {
      const gl = this.gl;
      
      // Clean up main mesh buffers
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.normalBuffer) gl.deleteBuffer(this.normalBuffer);
      if (this.uvBuffer) gl.deleteBuffer(this.uvBuffer);
      if (this.attributeBuffer) gl.deleteBuffer(this.attributeBuffer);
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      
      // Clean up LOD meshes
      for (const mesh of this.lodMeshes.values()) {
        gl.deleteVertexArray(mesh.vao);
        gl.deleteBuffer(mesh.posBuffer);
        gl.deleteBuffer(mesh.uvBuffer);
        gl.deleteBuffer(mesh.indexBuffer);
      }
      this.lodMeshes.clear();
      
      // Clean up heightmap textures
      if (this.heightmapTexture) gl.deleteTexture(this.heightmapTexture);
      if (this.erosionTexture) gl.deleteTexture(this.erosionTexture);
    }
    
    this.vao = null;
    this.positionBuffer = null;
    this.normalBuffer = null;
    this.uvBuffer = null;
    this.attributeBuffer = null;
    this.indexBuffer = null;
    this.heightmapTexture = null;
    this.erosionTexture = null;
    this.heightmap = null;
    this.erosionMap = null;
    this.terrainMesh = null;
    this.gl = null;
    
    super.destroy();
  }
}
