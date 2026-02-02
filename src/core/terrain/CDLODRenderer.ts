/**
 * CDLODRenderer - Renders terrain using CDLOD (Continuous Distance-Dependent LOD)
 * 
 * Uses a quadtree for LOD selection and renders terrain patches as instanced draws.
 * Each patch uses the same grid mesh but with different offset/scale uniforms.
 * 
 * Features:
 * - Single static grid mesh (instanced rendering)
 * - Vertex shader morphing for smooth LOD transitions
 * - Heightmap sampling from texture
 * - Frustum culling via quadtree
 */

import { mat4, vec3 } from 'gl-matrix';
import { registerShader, unregisterShader } from '../../demos/sceneBuilder/shaderManager';
import {
  shadowUniforms,
  shadowFunctions,
  hdrUniforms,
  lightingUniforms,
  pbrFunctions,
  iblFunctions,
  pbrLighting,
  toneMappingComplete,
} from '../../demos/sceneBuilder/shaderChunks';
import {
  TerrainQuadtree,
  TerrainNode,
  nodesToRenderData,
  type QuadtreeConfig,
  type SelectionResult,
} from './TerrainQuadtree';
import type { SceneLightingParams, DirectionalLightParams } from '../sceneObjects/lights';

/**
 * Grid mesh for CDLOD rendering
 */
interface CDLODGrid {
  vao: WebGLVertexArrayObject;
  vertexBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  vertexCount: number;
  indexCount: number;
  gridSize: number;
}

/**
 * Per-node instance data packed for GPU
 */
interface InstanceData {
  buffer: WebGLBuffer;
  data: Float32Array;
  maxInstances: number;
}

/**
 * Shader uniform locations
 */
interface CDLODShaderLocations {
  // Attributes
  aPosition: number;
  aTexCoord: number;
  
  // Per-instance attributes
  aNodeOffset: number;
  aNodeScale: number;
  aNodeMorph: number;
  aNodeLOD: number;
  
  // Matrices
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uLightSpaceMatrix: WebGLUniformLocation | null;
  
  // Terrain uniforms
  uHeightmap: WebGLUniformLocation | null;
  uErosionMap: WebGLUniformLocation | null;
  uHeightmapResolution: WebGLUniformLocation | null;
  uTerrainOrigin: WebGLUniformLocation | null;
  uTerrainSize: WebGLUniformLocation | null;
  uHeightScale: WebGLUniformLocation | null;
  uGridSize: WebGLUniformLocation | null;
  
  // Debug mode
  uDebugMode: WebGLUniformLocation | null;
  uUseSineWave: WebGLUniformLocation | null;
  
  // Material colors
  uGrassColor: WebGLUniformLocation | null;
  uRockColor: WebGLUniformLocation | null;
  uSnowColor: WebGLUniformLocation | null;
  uDirtColor: WebGLUniformLocation | null;
  
  // Material thresholds
  uSnowLine: WebGLUniformLocation | null;
  uRockLine: WebGLUniformLocation | null;
  uMaxGrassSlope: WebGLUniformLocation | null;
  
  // Lighting
  uLightDir: WebGLUniformLocation | null;
  uLightColor: WebGLUniformLocation | null;
  uAmbientIntensity: WebGLUniformLocation | null;
  uSkyColor: WebGLUniformLocation | null;
  uGroundColor: WebGLUniformLocation | null;
  uLightMode: WebGLUniformLocation | null;
  uCameraPos: WebGLUniformLocation | null;
  uToneMapping: WebGLUniformLocation | null;
  
  // HDR
  uHdrTexture: WebGLUniformLocation | null;
  uHasHdr: WebGLUniformLocation | null;
  uHdrExposure: WebGLUniformLocation | null;
  
  // Shadows
  uShadowMap: WebGLUniformLocation | null;
  uShadowEnabled: WebGLUniformLocation | null;
  uShadowBias: WebGLUniformLocation | null;
  
  // Selection
  uSelected: WebGLUniformLocation | null;
}

/**
 * Renderer ID counter
 */
let cdlodRendererId = 0;

/**
 * CDLODRenderer configuration
 */
export interface CDLODRendererConfig {
  /** Grid vertices per side (e.g., 33, 65) */
  gridSize: number;
  /** Maximum instances per draw call */
  maxInstances: number;
  /** Debug visualization mode */
  debugMode: boolean;
  /** Use sine wave heightmap (for testing) */
  useSineWave: boolean;
}

/**
 * Default renderer configuration
 */
export function createDefaultCDLODConfig(): CDLODRendererConfig {
  return {
    gridSize: 129,      // 128 cells (power of 2) for seamless LOD transitions
    maxInstances: 256,
    debugMode: false,
    useSineWave: true,  // Start with sine wave for testing
  };
}

/**
 * CDLODRenderer - Renders terrain using quadtree-based LOD
 */
export class CDLODRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shaderName: string;
  
  private config: CDLODRendererConfig;
  private quadtree: TerrainQuadtree;
  
  // Shader
  private program: WebGLProgram;
  private vs: WebGLShader;
  private fs: WebGLShader;
  private locations: CDLODShaderLocations;
  
  // Grid mesh
  private grid: CDLODGrid;
  
  // Instance data buffer
  private instanceData: InstanceData;
  
  // Last selection result (for debugging)
  private lastSelection: SelectionResult | null = null;
  
  // Reusable matrices
  private mvpMatrix = mat4.create();
  private vpMatrix = mat4.create();
  
  constructor(
    gl: WebGL2RenderingContext,
    quadtreeConfig?: Partial<QuadtreeConfig>,
    rendererConfig?: Partial<CDLODRendererConfig>
  ) {
    this.gl = gl;
    this.shaderName = `CDLOD Terrain #${cdlodRendererId++}`;
    this.config = { ...createDefaultCDLODConfig(), ...rendererConfig };
    
    // Create quadtree
    this.quadtree = new TerrainQuadtree(quadtreeConfig);
    
    // Create shader
    const { program, vs, fs } = this.createShader();
    this.program = program;
    this.vs = vs;
    this.fs = fs;
    this.locations = this.getLocations();
    
    // Create grid mesh
    this.grid = this.createGrid(this.config.gridSize);
    
    // Create instance data buffer
    this.instanceData = this.createInstanceBuffer(this.config.maxInstances);
    
    // Register for live shader editing
    registerShader(this.shaderName, {
      gl,
      program: this.program,
      vsSource: this.getVertexShaderSource(),
      fsSource: this.getFragmentShaderSource(),
      onRecompile: (newProgram: WebGLProgram) => {
        gl.deleteProgram(this.program);
        this.program = newProgram;
        this.locations = this.getLocations();
      },
    });
  }
  
  // ============ Shader Sources ============
  
  private getVertexShaderSource(): string {
    return `#version 300 es
    precision highp float;
    
    // Per-vertex attributes
    layout(location = 0) in vec3 aPosition;  // Grid position (XZ plane, Y=0)
    layout(location = 1) in vec2 aTexCoord;  // UV coordinates
    
    // Per-instance attributes
    layout(location = 2) in vec2 aNodeOffset; // Node center XZ
    layout(location = 3) in float aNodeScale; // World units per grid vertex
    layout(location = 4) in float aNodeMorph; // Morph factor 0-1
    layout(location = 5) in float aNodeLOD;   // LOD level
    
    // Matrices
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    // Terrain uniforms
    uniform sampler2D uHeightmap;
    uniform sampler2D uErosionMap;
    uniform float uHeightmapResolution;
    uniform vec2 uTerrainOrigin;
    uniform float uTerrainSize;
    uniform float uHeightScale;
    uniform float uGridSize;
    
    // Debug/test uniforms
    uniform bool uUseSineWave;
    
    // Outputs
    out vec3 vWorldPos;
    out vec3 vNormal;
    out vec2 vTexCoord;
    out vec2 vLocalUV;       // Local UV within the patch (0-1)
    out vec4 vLightSpacePos;
    out float vSlope;
    out float vErosion;
    out float vHeight;
    out float vMorphFactor;
    out float vLodLevel;
    
    // Generate height using sine waves (for testing)
    float sineWaveHeight(vec2 worldXZ) {
      float h = 0.0;
      // Multiple octaves of sine waves
      h += sin(worldXZ.x * 0.05) * 10.0;
      h += sin(worldXZ.y * 0.07) * 8.0;
      h += sin((worldXZ.x + worldXZ.y) * 0.03) * 15.0;
      h += sin(worldXZ.x * 0.2) * sin(worldXZ.y * 0.2) * 5.0;
      return h * 0.3; // Scale to reasonable range
    }
    
    // Sample height from heightmap texture
    float sampleHeightmap(vec2 worldXZ) {
      vec2 uv = (worldXZ - uTerrainOrigin) / uTerrainSize;
      uv = clamp(uv, 0.001, 0.999);
      return textureLod(uHeightmap, uv, 0.0).r;
    }
    
    // Get height at world position (switchable between sine and heightmap)
    float getHeight(vec2 worldXZ) {
      if (uUseSineWave) {
        return sineWaveHeight(worldXZ);
      } else {
        return sampleHeightmap(worldXZ);
      }
    }
    
    // Calculate normal from height samples
    vec3 calculateNormal(vec2 worldXZ, float sampleDist) {
      float hL = getHeight(worldXZ + vec2(-sampleDist, 0.0));
      float hR = getHeight(worldXZ + vec2(sampleDist, 0.0));
      float hD = getHeight(worldXZ + vec2(0.0, -sampleDist));
      float hU = getHeight(worldXZ + vec2(0.0, sampleDist));
      
      float dx = (hR - hL) / (2.0 * sampleDist);
      float dz = (hU - hD) / (2.0 * sampleDist);
      
      return normalize(vec3(-dx, 1.0, -dz));
    }
    
    void main() {
      // Grid vertex position (-0.5 to 0.5 range)
      vec2 gridPos = aPosition.xz;
      
      // Calculate world XZ position for this vertex
      vec2 worldXZ = gridPos * aNodeScale * (uGridSize - 1.0) + aNodeOffset;
      
      // ===== CDLOD Morphing =====
      // Vertices at "odd" positions in the parent grid need to morph
      // to the midpoint between their "even" neighbors when transitioning.
      
      // Calculate the parent (coarser) grid scale
      float parentScale = aNodeScale * 2.0;
      
      // Determine if this vertex is at an odd position in parent grid
      vec2 parentGridPos = worldXZ / parentScale;
      vec2 fracPart = fract(parentGridPos + 0.5);
      
      // Odd positions are those at 0.5 in fractional space
      float oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0);
      float oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0);
      
      // Apply morph factor to odd vertices
      float morphX = oddX * aNodeMorph;
      float morphZ = oddZ * aNodeMorph;
      
      // Snap to parent grid positions for morphing
      vec2 snappedXZ = floor(worldXZ / parentScale + 0.5) * parentScale;
      
      // Morph world position
      vec2 morphedXZ = vec2(
        mix(worldXZ.x, snappedXZ.x, morphX),
        mix(worldXZ.y, snappedXZ.y, morphZ)
      );
      
      // Sample height at morphed position
      float height = getHeight(morphedXZ);
      
      // Calculate normal (adjust sample distance based on morph)
      float normalMorph = max(morphX, morphZ);
      float sampleDist = mix(aNodeScale, parentScale, normalMorph);
      vec3 normal = calculateNormal(morphedXZ, sampleDist);
      
      // Final world position
      vec3 worldPos = vec3(morphedXZ.x, height, morphedXZ.y);
      
      // Transform to clip space
      gl_Position = uModelViewProjection * vec4(worldPos, 1.0);
      
      // Pass to fragment shader
      vec4 worldPos4 = uModel * vec4(worldPos, 1.0);
      vWorldPos = worldPos4.xyz;
      vNormal = normalize(mat3(uModel) * normal);
      vTexCoord = (morphedXZ - uTerrainOrigin) / uTerrainSize;
      vLocalUV = aTexCoord;  // Local UV from grid (0-1 within patch)
      vLightSpacePos = uLightSpaceMatrix * worldPos4;
      vSlope = 1.0 - normal.y;
      vHeight = height;
      vMorphFactor = aNodeMorph;
      vLodLevel = aNodeLOD;
      
      // Sample erosion (if not using sine wave)
      if (!uUseSineWave) {
        vec2 uv = clamp(vTexCoord, 0.001, 0.999);
        vErosion = textureLod(uErosionMap, uv, 0.0).r;
      } else {
        vErosion = 0.0;
      }
    }`;
  }
  
  private getFragmentShaderSource(): string {
    return `#version 300 es
    precision highp float;
    
    // Material colors
    uniform vec3 uGrassColor;
    uniform vec3 uRockColor;
    uniform vec3 uSnowColor;
    uniform vec3 uDirtColor;
    
    // Material thresholds
    uniform float uSnowLine;
    uniform float uRockLine;
    uniform float uMaxGrassSlope;
    
    // Terrain params
    uniform float uHeightScale;
    uniform float uTerrainSize;
    
    // Debug
    uniform bool uDebugMode;
    uniform bool uUseSineWave;
    
    // Selection
    uniform bool uSelected;
    uniform vec3 uCameraPos;
    
    ${lightingUniforms}
    ${hdrUniforms}
    ${shadowUniforms}
    ${shadowFunctions}
    ${pbrFunctions}
    ${iblFunctions}
    ${pbrLighting}
    ${toneMappingComplete}
    
    in vec3 vWorldPos;
    in vec3 vNormal;
    in vec2 vTexCoord;
    in vec2 vLocalUV;
    in vec4 vLightSpacePos;
    in float vSlope;
    in float vErosion;
    in float vHeight;
    in float vMorphFactor;
    in float vLodLevel;
    
    out vec4 fragColor;
    
    // Debug color palette for LOD levels
    vec3 getLODColor(float lod) {
      if (lod < 1.0) return vec3(1.0, 0.0, 0.0);      // Red - LOD 0
      if (lod < 2.0) return vec3(1.0, 0.5, 0.0);      // Orange - LOD 1
      if (lod < 3.0) return vec3(1.0, 1.0, 0.0);      // Yellow - LOD 2
      if (lod < 4.0) return vec3(0.0, 1.0, 0.0);      // Green - LOD 3
      if (lod < 5.0) return vec3(0.0, 1.0, 1.0);      // Cyan - LOD 4
      if (lod < 6.0) return vec3(0.0, 0.0, 1.0);      // Blue - LOD 5
      return vec3(1.0, 0.0, 1.0);                      // Magenta - LOD 6+
    }
    
    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      // Debug mode: show LOD levels with proper wireframe
      if (uDebugMode) {
        vec3 lodColor = getLODColor(vLodLevel);
        
        // Show morph factor as brightness variation
        lodColor = mix(lodColor, vec3(1.0), vMorphFactor * 0.3);
        
        // Wireframe using local UV - shows actual mesh grid within each patch
        // Scale by 8 to show internal grid lines (128 cells / 16 = 8 visible divisions)
        vec2 wireUV = fract(vLocalUV * 8.0);
        float wireGrid = step(0.92, max(wireUV.x, wireUV.y));
        
        // Patch boundary - thick lines at patch edges using local UV
        float edgeThreshold = 0.02;
        float patchEdge = 0.0;
        if (vLocalUV.x < edgeThreshold || vLocalUV.x > 1.0 - edgeThreshold ||
            vLocalUV.y < edgeThreshold || vLocalUV.y > 1.0 - edgeThreshold) {
          patchEdge = 1.0;
        }
        
        // Apply wireframe and patch edges
        vec3 wireColor = vec3(0.1, 0.1, 0.1);
        vec3 edgeColor = vec3(0.0, 0.0, 0.0);
        
        lodColor = mix(lodColor, wireColor, wireGrid * 0.6);
        lodColor = mix(lodColor, edgeColor, patchEdge * 0.8);
        
        fragColor = vec4(lodColor, 1.0);
        return;
      }
      
      // Normalize height for material blending
      float normalizedHeight = vHeight / max(uHeightScale, 1.0);
      float slope = vSlope;
      float erosion = min(vErosion * 2.0, 1.0);
      
      // Material weight calculation
      float snowWeight = smoothstep(uSnowLine - 0.1, uSnowLine + 0.1, normalizedHeight);
      snowWeight *= (1.0 - smoothstep(0.5, 0.8, slope));
      
      float rockWeight = smoothstep(uMaxGrassSlope - 0.1, uMaxGrassSlope + 0.1, slope);
      rockWeight = max(rockWeight, smoothstep(uRockLine - 0.1, uRockLine + 0.1, normalizedHeight) * 0.5);
      rockWeight = max(rockWeight, erosion * 0.7);
      
      float dirtWeight = erosion * (1.0 - normalizedHeight) * 0.5;
      float grassWeight = 1.0 - max(max(snowWeight, rockWeight), dirtWeight);
      
      // Normalize weights
      float totalWeight = snowWeight + rockWeight + dirtWeight + grassWeight;
      snowWeight /= totalWeight;
      rockWeight /= totalWeight;
      dirtWeight /= totalWeight;
      grassWeight /= totalWeight;
      
      // Blend albedo
      vec3 albedo = uGrassColor * grassWeight
                  + uRockColor * rockWeight
                  + uSnowColor * snowWeight
                  + uDirtColor * dirtWeight;
      
      // For sine wave testing, use simple colors
      if (uUseSineWave) {
        albedo = mix(vec3(0.3, 0.5, 0.2), vec3(0.6, 0.5, 0.4), slope);
      }
      
      // Material properties
      float metallic = 0.0;
      float roughness = mix(0.9, 0.7, snowWeight);
      roughness = mix(roughness, 0.95, rockWeight);
      
      // PBR lighting
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        albedo, metallic, roughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      // Tone mapping
      finalColor = applyToneMapping(finalColor, uToneMapping);
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      // Selection highlight
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.6, 0.3), 0.1);
      }
      
      fragColor = vec4(finalColor, 1.0);
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('CDLOD shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createShader() {
    const gl = this.gl;
    const vsSource = this.getVertexShaderSource();
    const fsSource = this.getFragmentShaderSource();
    
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('CDLOD program link error:', gl.getProgramInfoLog(program));
    }
    
    return { program, vs, fs };
  }
  
  private getLocations(): CDLODShaderLocations {
    const gl = this.gl;
    const p = this.program;
    
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aTexCoord: gl.getAttribLocation(p, 'aTexCoord'),
      aNodeOffset: gl.getAttribLocation(p, 'aNodeOffset'),
      aNodeScale: gl.getAttribLocation(p, 'aNodeScale'),
      aNodeMorph: gl.getAttribLocation(p, 'aNodeMorph'),
      aNodeLOD: gl.getAttribLocation(p, 'aNodeLOD'),
      
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
      
      uHeightmap: gl.getUniformLocation(p, 'uHeightmap'),
      uErosionMap: gl.getUniformLocation(p, 'uErosionMap'),
      uHeightmapResolution: gl.getUniformLocation(p, 'uHeightmapResolution'),
      uTerrainOrigin: gl.getUniformLocation(p, 'uTerrainOrigin'),
      uTerrainSize: gl.getUniformLocation(p, 'uTerrainSize'),
      uHeightScale: gl.getUniformLocation(p, 'uHeightScale'),
      uGridSize: gl.getUniformLocation(p, 'uGridSize'),
      
      uDebugMode: gl.getUniformLocation(p, 'uDebugMode'),
      uUseSineWave: gl.getUniformLocation(p, 'uUseSineWave'),
      
      uGrassColor: gl.getUniformLocation(p, 'uGrassColor'),
      uRockColor: gl.getUniformLocation(p, 'uRockColor'),
      uSnowColor: gl.getUniformLocation(p, 'uSnowColor'),
      uDirtColor: gl.getUniformLocation(p, 'uDirtColor'),
      
      uSnowLine: gl.getUniformLocation(p, 'uSnowLine'),
      uRockLine: gl.getUniformLocation(p, 'uRockLine'),
      uMaxGrassSlope: gl.getUniformLocation(p, 'uMaxGrassSlope'),
      
      uLightDir: gl.getUniformLocation(p, 'uLightDir'),
      uLightColor: gl.getUniformLocation(p, 'uLightColor'),
      uAmbientIntensity: gl.getUniformLocation(p, 'uAmbientIntensity'),
      uSkyColor: gl.getUniformLocation(p, 'uSkyColor'),
      uGroundColor: gl.getUniformLocation(p, 'uGroundColor'),
      uLightMode: gl.getUniformLocation(p, 'uLightMode'),
      uCameraPos: gl.getUniformLocation(p, 'uCameraPos'),
      uToneMapping: gl.getUniformLocation(p, 'uToneMapping'),
      
      uHdrTexture: gl.getUniformLocation(p, 'uHdrTexture'),
      uHasHdr: gl.getUniformLocation(p, 'uHasHdr'),
      uHdrExposure: gl.getUniformLocation(p, 'uHdrExposure'),
      
      uShadowMap: gl.getUniformLocation(p, 'uShadowMap'),
      uShadowEnabled: gl.getUniformLocation(p, 'uShadowEnabled'),
      uShadowBias: gl.getUniformLocation(p, 'uShadowBias'),
      
      uSelected: gl.getUniformLocation(p, 'uSelected'),
    };
  }
  
  // ============ Grid Mesh Creation ============
  
  /**
   * Create a static grid mesh for terrain patches
   */
  private createGrid(gridSize: number): CDLODGrid {
    const gl = this.gl;
    
    // Generate vertices: positions in -0.5 to 0.5 range
    const vertices: number[] = [];
    const halfSize = (gridSize - 1) * 0.5;
    
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        // Position (normalized -0.5 to 0.5)
        vertices.push((x - halfSize) / (gridSize - 1));
        vertices.push(0); // Y = 0, displaced in shader
        vertices.push((z - halfSize) / (gridSize - 1));
        
        // UV (0 to 1)
        vertices.push(x / (gridSize - 1));
        vertices.push(z / (gridSize - 1));
      }
    }
    
    // Generate indices
    const indices: number[] = [];
    for (let z = 0; z < gridSize - 1; z++) {
      for (let x = 0; x < gridSize - 1; x++) {
        const tl = z * gridSize + x;
        const tr = tl + 1;
        const bl = tl + gridSize;
        const br = bl + 1;
        
        indices.push(tl, bl, tr);
        indices.push(tr, bl, br);
      }
    }
    
    // Create VAO
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    
    // Vertex buffer (position + UV)
    const vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    
    // Position attribute (location 0)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 5 * 4, 0);
    
    // UV attribute (location 1)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 5 * 4, 3 * 4);
    
    // Index buffer
    const indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    
    gl.bindVertexArray(null);
    
    return {
      vao,
      vertexBuffer,
      indexBuffer,
      vertexCount: vertices.length / 5,
      indexCount: indices.length,
      gridSize,
    };
  }
  
  /**
   * Create instance data buffer for per-node attributes
   */
  private createInstanceBuffer(maxInstances: number): InstanceData {
    const gl = this.gl;
    
    // Per-instance data: offsetX, offsetZ, scale, morphFactor, lodLevel
    // = 5 floats per instance
    const floatsPerInstance = 5;
    const data = new Float32Array(maxInstances * floatsPerInstance);
    
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    
    return { buffer, data, maxInstances };
  }
  
  // ============ Rendering ============
  
  /**
   * Render terrain using CDLOD
   */
  render(
    vpMatrix: mat4,
    modelMatrix: mat4,
    cameraPos: vec3,
    terrainConfig: {
      worldSize: number;
      heightScale: number;
      resolution?: number;
      heightmapTexture?: WebGLTexture | null;
      erosionTexture?: WebGLTexture | null;
      material?: {
        grassColor: number[];
        rockColor: number[];
        snowColor: number[];
        dirtColor: number[];
        snowLine: number;
        rockLine: number;
        maxGrassSlope: number;
      };
    },
    isSelected: boolean = false,
    lightParams: SceneLightingParams | null = null
  ): void {
    const gl = this.gl;
    const loc = this.locations;
    
    // Update quadtree config if terrain size changed
    const currentConfig = this.quadtree.getConfig();
    if (terrainConfig.worldSize !== currentConfig.worldSize || 
        terrainConfig.heightScale * 2 !== currentConfig.maxHeight) {
      console.log(`[CDLOD] Rebuilding quadtree: worldSize ${currentConfig.worldSize} → ${terrainConfig.worldSize}, heightScale ${terrainConfig.heightScale}`);
      this.quadtree.setConfig({
        worldSize: terrainConfig.worldSize,
        minHeight: -terrainConfig.heightScale * 0.5,
        maxHeight: terrainConfig.heightScale * 2,
      });
      const stats = this.quadtree.getStats();
      console.log(`[CDLOD] Quadtree rebuilt: ${stats.totalNodes} nodes, maxDepth ${stats.maxDepth}`);
    }
    
    // Select visible nodes
    const cameraPosVec = vec3.fromValues(cameraPos[0], cameraPos[1], cameraPos[2]);
    const selection = this.quadtree.select(cameraPosVec, vpMatrix);
    this.lastSelection = selection;
    
    if (selection.nodes.length === 0) {
      return;
    }
    
    // Update instance buffer with selected nodes
    this.updateInstanceBuffer(selection.nodes);
    
    gl.useProgram(this.program);
    
    // Bind grid VAO
    gl.bindVertexArray(this.grid.vao);
    
    // Set up instance attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceData.buffer);
    
    // aNodeOffset (location 2): vec2
    gl.enableVertexAttribArray(loc.aNodeOffset);
    gl.vertexAttribPointer(loc.aNodeOffset, 2, gl.FLOAT, false, 5 * 4, 0);
    gl.vertexAttribDivisor(loc.aNodeOffset, 1);
    
    // aNodeScale (location 3): float
    gl.enableVertexAttribArray(loc.aNodeScale);
    gl.vertexAttribPointer(loc.aNodeScale, 1, gl.FLOAT, false, 5 * 4, 2 * 4);
    gl.vertexAttribDivisor(loc.aNodeScale, 1);
    
    // aNodeMorph (location 4): float
    gl.enableVertexAttribArray(loc.aNodeMorph);
    gl.vertexAttribPointer(loc.aNodeMorph, 1, gl.FLOAT, false, 5 * 4, 3 * 4);
    gl.vertexAttribDivisor(loc.aNodeMorph, 1);
    
    // aNodeLOD (location 5): float
    gl.enableVertexAttribArray(loc.aNodeLOD);
    gl.vertexAttribPointer(loc.aNodeLOD, 1, gl.FLOAT, false, 5 * 4, 4 * 4);
    gl.vertexAttribDivisor(loc.aNodeLOD, 1);
    
    // Matrices
    gl.uniformMatrix4fv(loc.uModelViewProjection, false, vpMatrix);
    gl.uniformMatrix4fv(loc.uModel, false, modelMatrix);
    
    // Terrain uniforms
    const terrainOriginX = -terrainConfig.worldSize * 0.5;
    const terrainOriginZ = -terrainConfig.worldSize * 0.5;
    gl.uniform2f(loc.uTerrainOrigin, terrainOriginX, terrainOriginZ);
    gl.uniform1f(loc.uTerrainSize, terrainConfig.worldSize);
    gl.uniform1f(loc.uHeightScale, terrainConfig.heightScale);
    gl.uniform1f(loc.uHeightmapResolution, terrainConfig.resolution || 512);
    gl.uniform1f(loc.uGridSize, this.config.gridSize);
    
    // Debug/test mode
    gl.uniform1i(loc.uDebugMode, this.config.debugMode ? 1 : 0);
    gl.uniform1i(loc.uUseSineWave, this.config.useSineWave ? 1 : 0);
    
    // Bind heightmap texture (TEXTURE0)
    if (terrainConfig.heightmapTexture && !this.config.useSineWave) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, terrainConfig.heightmapTexture);
      gl.uniform1i(loc.uHeightmap, 0);
    }
    
    // Bind erosion texture (TEXTURE3)
    if (terrainConfig.erosionTexture && !this.config.useSineWave) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, terrainConfig.erosionTexture);
      gl.uniform1i(loc.uErosionMap, 3);
    }
    
    // Material colors
    const mat = terrainConfig.material || {
      grassColor: [0.3, 0.5, 0.2],
      rockColor: [0.4, 0.35, 0.3],
      snowColor: [0.95, 0.95, 1.0],
      dirtColor: [0.4, 0.3, 0.2],
      snowLine: 0.75,
      rockLine: 0.6,
      maxGrassSlope: 0.5,
    };
    
    gl.uniform3fv(loc.uGrassColor, mat.grassColor as number[]);
    gl.uniform3fv(loc.uRockColor, mat.rockColor as number[]);
    gl.uniform3fv(loc.uSnowColor, mat.snowColor as number[]);
    gl.uniform3fv(loc.uDirtColor, mat.dirtColor as number[]);
    gl.uniform1f(loc.uSnowLine, mat.snowLine);
    gl.uniform1f(loc.uRockLine, mat.rockLine);
    gl.uniform1f(loc.uMaxGrassSlope, mat.maxGrassSlope);
    
    // Selection
    gl.uniform1i(loc.uSelected, isSelected ? 1 : 0);
    
    // Lighting
    let lightDir: number[] = [0.5, 1, 0.5];
    let lightColor: number[] = [1, 1, 1];
    let lightMode = 0;
    let ambient = 0.3;
    
    if (lightParams) {
      if (lightParams.type === 'directional') {
        const dirLight = lightParams as DirectionalLightParams;
        lightDir = [...dirLight.direction];
        lightColor = dirLight.effectiveColor;
        ambient = dirLight.ambient;
      } else if (lightParams.type === 'hdr') {
        lightMode = 1;
        ambient = lightParams.ambient;
      }
    }
    
    gl.uniform3fv(loc.uLightDir, lightDir as any);
    gl.uniform3fv(loc.uLightColor, lightColor as any);
    gl.uniform1f(loc.uAmbientIntensity, ambient);
    gl.uniform1i(loc.uLightMode, lightMode);
    
    const dirParams = lightParams?.type === 'directional' ? lightParams as DirectionalLightParams : null;
    gl.uniform3fv(loc.uSkyColor, dirParams?.skyColor || [0.4, 0.6, 1.0]);
    gl.uniform3fv(loc.uGroundColor, dirParams?.groundColor || [0.3, 0.25, 0.2]);
    
    gl.uniform3fv(loc.uCameraPos, [cameraPos[0], cameraPos[1], cameraPos[2]]);
    gl.uniform1i(loc.uToneMapping, lightParams?.toneMapping !== undefined ? lightParams.toneMapping : 3);
    
    // HDR
    const hdrTexture = lightParams?.type === 'hdr' ? (lightParams as any).hdrTexture : null;
    const hdrExposure = lightParams?.type === 'hdr' ? (lightParams as any).exposure : 1.0;
    gl.uniform1i(loc.uHasHdr, hdrTexture ? 1 : 0);
    gl.uniform1f(loc.uHdrExposure, hdrExposure);
    
    if (hdrTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, hdrTexture);
      gl.uniform1i(loc.uHdrTexture, 1);
    }
    
    // Shadows
    gl.uniform1i(loc.uShadowEnabled, lightParams?.shadowEnabled ? 1 : 0);
    gl.uniform1f(loc.uShadowBias, lightParams?.shadowBias || 0.002);
    
    if (lightParams?.lightSpaceMatrix) {
      gl.uniformMatrix4fv(loc.uLightSpaceMatrix, false, lightParams.lightSpaceMatrix as Float32Array);
    } else {
      gl.uniformMatrix4fv(loc.uLightSpaceMatrix, false, mat4.create());
    }
    
    if (lightParams?.shadowMap) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, lightParams.shadowMap);
      gl.uniform1i(loc.uShadowMap, 2);
    }
    
    // Draw instanced
    gl.drawElementsInstanced(
      gl.TRIANGLES,
      this.grid.indexCount,
      gl.UNSIGNED_INT,
      0,
      selection.nodes.length
    );
    
    // Reset vertex attribute divisors
    gl.vertexAttribDivisor(loc.aNodeOffset, 0);
    gl.vertexAttribDivisor(loc.aNodeScale, 0);
    gl.vertexAttribDivisor(loc.aNodeMorph, 0);
    gl.vertexAttribDivisor(loc.aNodeLOD, 0);
    
    gl.bindVertexArray(null);
  }
  
  /**
   * Update instance buffer with selected node data
   */
  private updateInstanceBuffer(nodes: TerrainNode[]): void {
    const gl = this.gl;
    const data = this.instanceData.data;
    const floatsPerInstance = 5;
    
    // Ensure we don't exceed buffer size
    const count = Math.min(nodes.length, this.instanceData.maxInstances);
    
    for (let i = 0; i < count; i++) {
      const node = nodes[i];
      const offset = i * floatsPerInstance;
      
      // offsetX, offsetZ, scale, morphFactor, lodLevel
      data[offset + 0] = node.center[0];
      data[offset + 1] = node.center[2];
      data[offset + 2] = node.size / (this.config.gridSize - 1);
      data[offset + 3] = node.morphFactor;
      data[offset + 4] = node.lodLevel;
    }
    
    // Upload to GPU
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceData.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * floatsPerInstance));
  }
  
  // ============ Configuration ============
  
  /**
   * Set debug mode
   */
  setDebugMode(enabled: boolean): void {
    this.config.debugMode = enabled;
  }
  
  /**
   * Set sine wave test mode
   */
  setUseSineWave(enabled: boolean): void {
    this.config.useSineWave = enabled;
  }
  
  /**
   * Get quadtree for external inspection
   */
  getQuadtree(): TerrainQuadtree {
    return this.quadtree;
  }
  
  /**
   * Get last selection result (for debugging)
   */
  getLastSelection(): SelectionResult | null {
    return this.lastSelection;
  }
  
  /**
   * Get renderer configuration
   */
  getConfig(): CDLODRendererConfig {
    return this.config;
  }
  
  // ============ Cleanup ============
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    unregisterShader(this.shaderName);
    
    const gl = this.gl;
    
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
    
    gl.deleteVertexArray(this.grid.vao);
    gl.deleteBuffer(this.grid.vertexBuffer);
    gl.deleteBuffer(this.grid.indexBuffer);
    
    gl.deleteBuffer(this.instanceData.buffer);
  }
}
