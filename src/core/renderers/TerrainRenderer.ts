/**
 * TerrainRenderer - Renders procedural terrain with height/slope-based material blending
 */

import { mat4 } from 'gl-matrix';
import { registerShader, unregisterShader } from '../../demos/sceneBuilder/shaderManager';
import { shadowUniforms, shadowFunctions, hdrUniforms, lightingUniforms, pbrFunctions, iblFunctions, pbrLighting, toneMappingComplete } from '../../demos/sceneBuilder/shaderChunks';
import type { TerrainObject } from '../sceneObjects';
import type { SceneLightingParams, DirectionalLightParams } from '../sceneObjects/lights';
import { ClipmapGeometry, snapToGrid, type ClipmapConfig } from './ClipmapGeometry';

// Renderer ID counter
let terrainRendererId = 0;

/**
 * Terrain shader uniform locations
 */
interface TerrainShaderLocations {
  // Attributes
  aPosition: number;
  aNormal: number;
  aTexCoord: number;
  aTerrainAttrib: number; // vec2: slope, erosion
  
  // Matrices
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uLightSpaceMatrix: WebGLUniformLocation | null;
  
  // Material colors
  uGrassColor: WebGLUniformLocation | null;
  uRockColor: WebGLUniformLocation | null;
  uSnowColor: WebGLUniformLocation | null;
  uDirtColor: WebGLUniformLocation | null;
  
  // Material thresholds
  uSnowLine: WebGLUniformLocation | null;
  uRockLine: WebGLUniformLocation | null;
  uMaxGrassSlope: WebGLUniformLocation | null;
  
  // Terrain params
  uHeightScale: WebGLUniformLocation | null;
  uWorldSize: WebGLUniformLocation | null;
  
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

interface OutlineLocations {
  aPosition: number;
  aNormal: number;
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uOutlineWidth: WebGLUniformLocation | null;
  uOutlineColor: WebGLUniformLocation | null;
}

interface WireLocations {
  aPosition: number;
  uModelViewProjection: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
}

/**
 * Clipmap shader locations
 */
interface ClipmapShaderLocations {
  aPosition: number;
  aTexCoord: number;
  
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uLightSpaceMatrix: WebGLUniformLocation | null;
  
  // Clipmap-specific uniforms
  uRingOffset: WebGLUniformLocation | null;   // Ring center in world space (XZ)
  uRingScale: WebGLUniformLocation | null;    // World units per vertex
  uNextRingScale: WebGLUniformLocation | null;// Next (coarser) ring scale for morphing
  uRingIndex: WebGLUniformLocation | null;    // Current ring index (0 = innermost)
  uRingCount: WebGLUniformLocation | null;    // Total number of rings
  uGridSize: WebGLUniformLocation | null;     // Grid vertices per side
  uTerrainOrigin: WebGLUniformLocation | null;// Terrain world origin (XZ)
  uTerrainSize: WebGLUniformLocation | null;  // Total terrain size
  
  uHeightmap: WebGLUniformLocation | null;
  uErosionMap: WebGLUniformLocation | null;
  uHeightmapResolution: WebGLUniformLocation | null;
  
  // Material colors
  uGrassColor: WebGLUniformLocation | null;
  uRockColor: WebGLUniformLocation | null;
  uSnowColor: WebGLUniformLocation | null;
  uDirtColor: WebGLUniformLocation | null;
  
  // Material thresholds
  uSnowLine: WebGLUniformLocation | null;
  uRockLine: WebGLUniformLocation | null;
  uMaxGrassSlope: WebGLUniformLocation | null;
  
  // Terrain params
  uHeightScale: WebGLUniformLocation | null;
  uWorldSize: WebGLUniformLocation | null;
  
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
 * TerrainRenderer - Renders TerrainObject instances
 */
export class TerrainRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly shaderName: string;
  private readonly clipmapShaderName: string;
  
  // Main terrain shader
  private mainProgram: WebGLProgram;
  private mainVs: WebGLShader;
  private mainFs: WebGLShader;
  private locations: TerrainShaderLocations;
  
  // Outline shader
  private outlineProgram: WebGLProgram;
  private outlineVs: WebGLShader;
  private outlineFs: WebGLShader;
  private outlineLocations: OutlineLocations;
  
  // Wireframe shader
  private wireProgram: WebGLProgram;
  private wireVs: WebGLShader;
  private wireFs: WebGLShader;
  private wireLocations: WireLocations;
  
  // Clipmap shader
  private clipmapProgram: WebGLProgram;
  private clipmapVs: WebGLShader;
  private clipmapFs: WebGLShader;
  private clipmapLocations: ClipmapShaderLocations;
  
  // Clipmap geometry
  private clipmapGeometry: ClipmapGeometry | null = null;
  
  // Track terrain params for clipmap auto-configuration
  private lastTerrainWorldSize: number = 0;
  private lastTerrainResolution: number = 0;
  
  // Reusable MVP matrix
  private mvpMatrix = mat4.create();
  
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.shaderName = `Terrain #${terrainRendererId++}`;
    
    // Compile main terrain shader
    const { program: mainProg, vs: mainV, fs: mainF } = this.createMainShader();
    this.mainProgram = mainProg;
    this.mainVs = mainV;
    this.mainFs = mainF;
    this.locations = this.getMainLocations();
    
    // Compile outline shader
    const { program: outlineProg, vs: outlineV, fs: outlineF } = this.createOutlineShader();
    this.outlineProgram = outlineProg;
    this.outlineVs = outlineV;
    this.outlineFs = outlineF;
    this.outlineLocations = this.getOutlineLocations();
    
    // Compile wireframe shader
    const { program: wireProg, vs: wireV, fs: wireF } = this.createWireShader();
    this.wireProgram = wireProg;
    this.wireVs = wireV;
    this.wireFs = wireF;
    this.wireLocations = this.getWireLocations();
    
    // Compile clipmap shader
    const { program: clipmapProg, vs: clipmapV, fs: clipmapF } = this.createClipmapShader();
    this.clipmapProgram = clipmapProg;
    this.clipmapVs = clipmapV;
    this.clipmapFs = clipmapF;
    this.clipmapLocations = this.getClipmapLocations();
    
    // Initialize clipmap geometry with config that matches typical terrain size
    // For 50-unit terrain: 5 rings × 2^4 scale factor × 64 grid × 0.15 = ~150 units coverage
    // We want coverage roughly equal to terrain size
    this.clipmapGeometry = new ClipmapGeometry(gl, {
      ringCount: 4,       // Fewer rings = less extension beyond terrain
      gridSize: 64,       // Grid density per ring
      baseScale: 0.25,    // Start with larger scale (fits 50-unit terrain better)
    });
    
    // Register for live shader editing
    registerShader(this.shaderName, {
      gl,
      program: this.mainProgram,
      vsSource: this.getMainVsSource(),
      fsSource: this.getMainFsSource(),
      onRecompile: (newProgram: WebGLProgram) => {
        gl.deleteProgram(this.mainProgram);
        this.mainProgram = newProgram;
        this.locations = this.getMainLocations();
      },
    });
    
    // Register clipmap shader for live editing (enables vertex shader experimentation)
    this.clipmapShaderName = `Terrain Clipmap #${terrainRendererId - 1}`;
    registerShader(this.clipmapShaderName, {
      gl,
      program: this.clipmapProgram,
      vsSource: this.getClipmapVsSource(),
      fsSource: this.getClipmapFsSource(), // Clipmap-specific FS with bounds checking
      onRecompile: (newProgram: WebGLProgram) => {
        gl.deleteProgram(this.clipmapProgram);
        this.clipmapProgram = newProgram;
        this.clipmapLocations = this.getClipmapLocations();
      },
    });
  }
  
  // ============ Shader Sources ============
  
  private getMainVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    layout(location = 0) in vec3 aPosition;
    layout(location = 1) in vec3 aNormal;
    layout(location = 2) in vec2 aTexCoord;
    layout(location = 3) in vec2 aTerrainAttrib; // x = slope, y = erosion
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    out vec3 vWorldPos;
    out vec3 vNormal;
    out vec2 vTexCoord;
    out vec4 vLightSpacePos;
    out float vSlope;
    out float vErosion;
    out float vHeight;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      
      vWorldPos = worldPos.xyz;
      vNormal = normalize(mat3(uModel) * aNormal);
      vTexCoord = aTexCoord;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
      vSlope = aTerrainAttrib.x;
      vErosion = aTerrainAttrib.y;
      vHeight = aPosition.y; // Local height before transform
    }`;
  }
  
  private getMainFsSource(): string {
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
    uniform float uWorldSize;
    
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
    in vec4 vLightSpacePos;
    in float vSlope;
    in float vErosion;
    in float vHeight;
    
    out vec4 fragColor;
    
    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      // Normalize height to 0-1 range
      float normalizedHeight = vHeight / uHeightScale;
      
      // Calculate material weights based on height, slope, and erosion
      float slope = vSlope;
      float erosion = min(vErosion * 2.0, 1.0); // Amplify erosion visibility
      
      // Snow: high altitude, not too steep
      float snowWeight = smoothstep(uSnowLine - 0.1, uSnowLine + 0.1, normalizedHeight);
      snowWeight *= (1.0 - smoothstep(0.5, 0.8, slope)); // Less snow on steep slopes
      
      // Rock: steep slopes or high erosion areas
      float rockWeight = smoothstep(uMaxGrassSlope - 0.1, uMaxGrassSlope + 0.1, slope);
      rockWeight = max(rockWeight, smoothstep(uRockLine - 0.1, uRockLine + 0.1, normalizedHeight) * 0.5);
      rockWeight = max(rockWeight, erosion * 0.7); // Erosion exposes rock
      
      // Dirt: eroded areas at lower elevations
      float dirtWeight = erosion * (1.0 - normalizedHeight) * 0.5;
      
      // Grass: everything else
      float grassWeight = 1.0 - max(max(snowWeight, rockWeight), dirtWeight);
      
      // Normalize weights
      float totalWeight = snowWeight + rockWeight + dirtWeight + grassWeight;
      snowWeight /= totalWeight;
      rockWeight /= totalWeight;
      dirtWeight /= totalWeight;
      grassWeight /= totalWeight;
      
      // Blend albedo colors
      vec3 albedo = uGrassColor * grassWeight 
                  + uRockColor * rockWeight 
                  + uSnowColor * snowWeight 
                  + uDirtColor * dirtWeight;
      
      // Material properties vary by type
      float metallic = 0.0; // Terrain is non-metallic
      float roughness = mix(0.9, 0.7, snowWeight); // Snow is slightly smoother
      roughness = mix(roughness, 0.95, rockWeight); // Rock is rough
      
      // Calculate PBR lighting
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        albedo, metallic, roughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      // Apply tone mapping
      finalColor = applyToneMapping(finalColor, uToneMapping);
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      // Selection highlight
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.6, 0.3), 0.1);
      }
      
      fragColor = vec4(finalColor, 1.0);
      // fragColor = vec4(vec3(vHeight), 1.0);
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Terrain shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createProgram(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Terrain program link error:', gl.getProgramInfoLog(program));
    }
    return program;
  }
  
  private createMainShader() {
    const vs = this.compileShader(this.gl.VERTEX_SHADER, this.getMainVsSource());
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, this.getMainFsSource());
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  private createOutlineShader() {
    const vsSource = `#version 300 es
    precision highp float;
    layout(location = 0) in vec3 aPosition;
    layout(location = 1) in vec3 aNormal;
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform float uOutlineWidth;
    void main() {
      vec3 normal = normalize(mat3(uModel) * aNormal);
      vec3 expandedPos = aPosition + normal * uOutlineWidth;
      gl_Position = uModelViewProjection * vec4(expandedPos, 1.0);
    }`;
    
    const fsSource = `#version 300 es
    precision mediump float;
    uniform vec3 uOutlineColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(uOutlineColor, 1.0);
    }`;
    
    const vs = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  private createWireShader() {
    const vsSource = `#version 300 es
    precision highp float;
    layout(location = 0) in vec3 aPosition;
    uniform mat4 uModelViewProjection;
    void main() {
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
    }`;
    
    const fsSource = `#version 300 es
    precision mediump float;
    uniform vec3 uColor;
    out vec4 fragColor;
    void main() {
      fragColor = vec4(uColor, 1.0);
    }`;
    
    const vs = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  /**
   * Get clipmap vertex shader source (for live editing)
   */
  private getClipmapVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    layout(location = 0) in vec3 aPosition;
    layout(location = 2) in vec2 aTexCoord;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    // Clipmap-specific uniforms
    uniform vec2 uRingOffset;       // Ring center in world space (XZ)
    uniform float uRingScale;       // World units per vertex (current ring)
    uniform float uNextRingScale;   // Next (coarser) ring scale for morphing
    uniform int uRingIndex;         // Current ring index (0 = innermost)
    uniform int uRingCount;         // Total number of rings
    uniform int uGridSize;          // Grid vertices per side
    uniform vec2 uTerrainOrigin;    // Terrain world origin (XZ)
    uniform float uTerrainSize;     // Total terrain size
    
    uniform sampler2D uHeightmap;
    uniform sampler2D uErosionMap;
    uniform float uHeightmapResolution;
    uniform float uHeightScale;
    
    out vec3 vWorldPos;
    out vec3 vNormal;
    out vec2 vTexCoord;
    out vec4 vLightSpacePos;
    out float vSlope;
    out float vErosion;
    out float vHeight;
    out vec2 vTerrainOrigin;    // Pass to fragment shader for bounds check
    out float vTerrainSize;
    
    // Sample height at given world XZ position
    float sampleHeight(vec2 worldXZ) {
      vec2 uv = (worldXZ - uTerrainOrigin) / uTerrainSize;
      uv = clamp(uv, 0.001, 0.999);
      return textureLod(uHeightmap, uv, 0.0).r;
    }
    
    void main() {
      // Grid vertex position (integer grid coordinates from -halfSize to +halfSize)
      vec2 gridPos = aPosition.xz;
      
      // Transform to world position
      vec2 worldXZ = gridPos * uRingScale + uRingOffset;
      
      // ===== Grid-Based Geomorphing =====
      // Vertices at "odd" positions in the coarser grid need to morph
      // to the midpoint between their "even" neighbors.
      //
      // When transitioning from scale S to scale 2S:
      // - Even vertices (divisible by 2 in coarse grid) stay in place
      // - Odd vertices morph to the average of their even neighbors
      
      float halfGridSize = float(uGridSize - 1) * 0.5;
      float ringRadius = halfGridSize * uRingScale;
      
      // Distance from ring center (using max for square rings)
      vec2 localPos = worldXZ - uRingOffset;
      float distFromCenter = max(abs(localPos.x), abs(localPos.y));
      
      // Morph region: outer portion of ring transitions to coarser LOD
      // Start morphing at 60% of ring radius, complete at 100%
      float morphStart = ringRadius * 0.6;
      float morphEnd = ringRadius;
      
      // Calculate base morph factor from distance
      float distMorph = 0.0;
      if (uRingIndex < uRingCount - 1) {
        distMorph = smoothstep(morphStart, morphEnd, distFromCenter);
      }
      
      // Determine if this vertex is at an "odd" position in the coarser grid
      // A vertex is "odd" if its world position, when divided by the coarser scale,
      // doesn't land on an integer
      vec2 coarseGridPos = worldXZ / uNextRingScale;
      vec2 fracPart = fract(coarseGridPos + 0.5); // +0.5 to handle negative coords
      
      // Check if X or Z coordinate is at an odd position (0.5 in fractional part)
      // Odd positions are those that fall between coarse grid points
      float oddX = 1.0 - abs(fracPart.x * 2.0 - 1.0); // 1 at 0.5, 0 at 0 or 1
      float oddZ = 1.0 - abs(fracPart.y * 2.0 - 1.0); // 1 at 0.5, 0 at 0 or 1
      
      // Morph factor: odd vertices morph more, even vertices stay put
      // Vertices odd in X morph in X, vertices odd in Z morph in Z
      float morphX = oddX * distMorph;
      float morphZ = oddZ * distMorph;
      
      // Calculate the snapped (even) position by rounding to coarser grid
      vec2 snappedXZ = floor(worldXZ / uNextRingScale + 0.5) * uNextRingScale;
      
      // Morph position: blend toward snapped position for odd vertices
      vec2 morphedXZ = vec2(
        mix(worldXZ.x, snappedXZ.x, morphX),
        mix(worldXZ.y, snappedXZ.y, morphZ)
      );
      
      // Sample heights at original and morphed positions
      float originalHeight = sampleHeight(worldXZ);
      float morphedHeight = sampleHeight(morphedXZ);
      
      // For height, use max morph factor to ensure smooth blending
      float heightMorph = max(morphX, morphZ);
      float height = mix(originalHeight, morphedHeight, heightMorph);
      
      // Calculate UV for other texture sampling
      vec2 uv = (morphedXZ - uTerrainOrigin) / uTerrainSize;
      uv = clamp(uv, 0.001, 0.999);
      
      // Sample erosion at morphed position
      float erosion = textureLod(uErosionMap, uv, 0.0).r;
      
      // Construct displaced position
      vec3 displacedPos = vec3(morphedXZ.x, height, morphedXZ.y);
      
      // Calculate normal from heightmap neighbors
      float texelSize = 1.0 / uHeightmapResolution;
      float worldTexelSize = uTerrainSize / uHeightmapResolution;
      
      // Scale sample distance based on morph factor for consistent normals
      float normalMorph = max(morphX, morphZ);
      float sampleDist = mix(texelSize, texelSize * 2.0, normalMorph);
      
      float hL = textureLod(uHeightmap, uv + vec2(-sampleDist, 0.0), 0.0).r;
      float hR = textureLod(uHeightmap, uv + vec2(sampleDist, 0.0), 0.0).r;
      float hD = textureLod(uHeightmap, uv + vec2(0.0, -sampleDist), 0.0).r;
      float hU = textureLod(uHeightmap, uv + vec2(0.0, sampleDist), 0.0).r;
      
      // Calculate gradient in world space
      float worldSampleDist = mix(worldTexelSize, worldTexelSize * 2.0, normalMorph);
      float dx = (hR - hL) / (2.0 * worldSampleDist);
      float dz = (hU - hD) / (2.0 * worldSampleDist);
      
      // Normal = normalize(-dx, 1, -dz)
      vec3 normal = normalize(vec3(-dx, 1.0, -dz));
      
      // Calculate slope
      float slope = 1.0 - normal.y;
      
      vec4 worldPos = uModel * vec4(displacedPos, 1.0);
      
      gl_Position = uModelViewProjection * vec4(displacedPos, 1.0);
      
      vWorldPos = worldPos.xyz;
      vNormal = normalize(mat3(uModel) * normal);
      vTexCoord = uv;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
      vSlope = slope;
      vErosion = erosion;
      vHeight = height;
      vTerrainOrigin = uTerrainOrigin;
      vTerrainSize = uTerrainSize;
    }`;
  }
  
  /**
   * Get clipmap fragment shader source (includes terrain bounds check)
   */
  private getClipmapFsSource(): string {
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
    uniform float uWorldSize;
    
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
    in vec4 vLightSpacePos;
    in float vSlope;
    in float vErosion;
    in float vHeight;
    in vec2 vTerrainOrigin;
    in float vTerrainSize;
    
    out vec4 fragColor;
    
    void main() {
      // Discard fragments outside terrain bounds
      vec2 boundsMin = vTerrainOrigin;
      vec2 boundsMax = vTerrainOrigin + vec2(vTerrainSize);
      if (vWorldPos.x < boundsMin.x || vWorldPos.x > boundsMax.x ||
          vWorldPos.z < boundsMin.y || vWorldPos.z > boundsMax.y) {
        discard;
      }
      
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      // Normalize height to 0-1 range
      float normalizedHeight = vHeight / uHeightScale;
      
      // Calculate material weights based on height, slope, and erosion
      float slope = vSlope;
      float erosion = min(vErosion * 2.0, 1.0); // Amplify erosion visibility
      
      // Snow: high altitude, not too steep
      float snowWeight = smoothstep(uSnowLine - 0.1, uSnowLine + 0.1, normalizedHeight);
      snowWeight *= (1.0 - smoothstep(0.5, 0.8, slope)); // Less snow on steep slopes
      
      // Rock: steep slopes or high erosion areas
      float rockWeight = smoothstep(uMaxGrassSlope - 0.1, uMaxGrassSlope + 0.1, slope);
      rockWeight = max(rockWeight, smoothstep(uRockLine - 0.1, uRockLine + 0.1, normalizedHeight) * 0.5);
      rockWeight = max(rockWeight, erosion * 0.7); // Erosion exposes rock
      
      // Dirt: eroded areas at lower elevations
      float dirtWeight = erosion * (1.0 - normalizedHeight) * 0.5;
      
      // Grass: everything else
      float grassWeight = 1.0 - max(max(snowWeight, rockWeight), dirtWeight);
      
      // Normalize weights
      float totalWeight = snowWeight + rockWeight + dirtWeight + grassWeight;
      snowWeight /= totalWeight;
      rockWeight /= totalWeight;
      dirtWeight /= totalWeight;
      grassWeight /= totalWeight;
      
      // Blend albedo colors
      vec3 albedo = uGrassColor * grassWeight 
                  + uRockColor * rockWeight 
                  + uSnowColor * snowWeight 
                  + uDirtColor * dirtWeight;
      
      // Material properties vary by type
      float metallic = 0.0; // Terrain is non-metallic
      float roughness = mix(0.9, 0.7, snowWeight); // Snow is slightly smoother
      roughness = mix(roughness, 0.95, rockWeight); // Rock is rough
      
      // Calculate PBR lighting
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        albedo, metallic, roughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      // Apply tone mapping
      finalColor = applyToneMapping(finalColor, uToneMapping);
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      // Selection highlight
      if (uSelected) {
        finalColor = mix(finalColor, vec3(1.0, 0.6, 0.3), 0.1);
      }
      
      fragColor = vec4(finalColor, 1.0);
    }`;
  }
  
  /**
   * Create clipmap displacement shader
   */
  private createClipmapShader() {
    const vsSource = this.getClipmapVsSource();
    const fsSource = this.getClipmapFsSource();
    
    const vs = this.compileShader(this.gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(this.gl.FRAGMENT_SHADER, fsSource);
    const program = this.createProgram(vs, fs);
    return { program, vs, fs };
  }
  
  // ============ Uniform Locations ============
  
  private getMainLocations(): TerrainShaderLocations {
    const gl = this.gl;
    const p = this.mainProgram;
    
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aNormal: gl.getAttribLocation(p, 'aNormal'),
      aTexCoord: gl.getAttribLocation(p, 'aTexCoord'),
      aTerrainAttrib: gl.getAttribLocation(p, 'aTerrainAttrib'),
      
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
      
      uGrassColor: gl.getUniformLocation(p, 'uGrassColor'),
      uRockColor: gl.getUniformLocation(p, 'uRockColor'),
      uSnowColor: gl.getUniformLocation(p, 'uSnowColor'),
      uDirtColor: gl.getUniformLocation(p, 'uDirtColor'),
      
      uSnowLine: gl.getUniformLocation(p, 'uSnowLine'),
      uRockLine: gl.getUniformLocation(p, 'uRockLine'),
      uMaxGrassSlope: gl.getUniformLocation(p, 'uMaxGrassSlope'),
      
      uHeightScale: gl.getUniformLocation(p, 'uHeightScale'),
      uWorldSize: gl.getUniformLocation(p, 'uWorldSize'),
      
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
  
  private getOutlineLocations(): OutlineLocations {
    const gl = this.gl;
    const p = this.outlineProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aNormal: gl.getAttribLocation(p, 'aNormal'),
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uOutlineWidth: gl.getUniformLocation(p, 'uOutlineWidth'),
      uOutlineColor: gl.getUniformLocation(p, 'uOutlineColor'),
    };
  }
  
  private getWireLocations(): WireLocations {
    const gl = this.gl;
    const p = this.wireProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uColor: gl.getUniformLocation(p, 'uColor'),
    };
  }
  
  private getClipmapLocations(): ClipmapShaderLocations {
    const gl = this.gl;
    const p = this.clipmapProgram;
    
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aTexCoord: gl.getAttribLocation(p, 'aTexCoord'),
      
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
      
      uRingOffset: gl.getUniformLocation(p, 'uRingOffset'),
      uRingScale: gl.getUniformLocation(p, 'uRingScale'),
      uNextRingScale: gl.getUniformLocation(p, 'uNextRingScale'),
      uRingIndex: gl.getUniformLocation(p, 'uRingIndex'),
      uRingCount: gl.getUniformLocation(p, 'uRingCount'),
      uGridSize: gl.getUniformLocation(p, 'uGridSize'),
      uTerrainOrigin: gl.getUniformLocation(p, 'uTerrainOrigin'),
      uTerrainSize: gl.getUniformLocation(p, 'uTerrainSize'),
      
      uHeightmap: gl.getUniformLocation(p, 'uHeightmap'),
      uErosionMap: gl.getUniformLocation(p, 'uErosionMap'),
      uHeightmapResolution: gl.getUniformLocation(p, 'uHeightmapResolution'),
      
      uGrassColor: gl.getUniformLocation(p, 'uGrassColor'),
      uRockColor: gl.getUniformLocation(p, 'uRockColor'),
      uSnowColor: gl.getUniformLocation(p, 'uSnowColor'),
      uDirtColor: gl.getUniformLocation(p, 'uDirtColor'),
      
      uSnowLine: gl.getUniformLocation(p, 'uSnowLine'),
      uRockLine: gl.getUniformLocation(p, 'uRockLine'),
      uMaxGrassSlope: gl.getUniformLocation(p, 'uMaxGrassSlope'),
      
      uHeightScale: gl.getUniformLocation(p, 'uHeightScale'),
      uWorldSize: gl.getUniformLocation(p, 'uWorldSize'),
      
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
  
  // ============ Rendering ============
  
  /**
   * Render a terrain object
   */
  render(
    terrain: TerrainObject,
    vpMatrix: mat4,
    modelMatrix: mat4,
    isSelected: boolean,
    wireframeMode: boolean = false,
    lightParams: SceneLightingParams | null = null
  ): void {
    if (!terrain.hasGenerated()) {
      console.warn('[TerrainRenderer] Terrain not yet generated');
      return;
    }
    
    const vao = terrain.getVAO();
    const indexCount = terrain.getIndexCount();
    if (!vao) {
      console.warn('[TerrainRenderer] Terrain VAO is null');
      return;
    }
    if (indexCount === 0) {
      console.warn('[TerrainRenderer] Terrain indexCount is 0');
      return;
    }
    
    if (wireframeMode) {
      this.renderWireframe(terrain, vpMatrix, modelMatrix, isSelected);
      return;
    }
    
    // Render outline for selected terrain
    if (isSelected) {
      this.renderOutline(terrain, vpMatrix, modelMatrix);
    }
    
    const gl = this.gl;
    const loc = this.locations;
    const material = terrain.getMaterialParams();
    const params = terrain.params;
    // console.debug('[TerrainRenderer] Terrain params:', params);
    
    // Calculate MVP
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.mainProgram);
    
    // Bind terrain VAO
    gl.bindVertexArray(vao);
    
    // Matrices
    gl.uniformMatrix4fv(loc.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(loc.uModel, false, modelMatrix);
    
    // Material colors
    gl.uniform3fv(loc.uGrassColor, material.grassColor);
    gl.uniform3fv(loc.uRockColor, material.rockColor);
    gl.uniform3fv(loc.uSnowColor, material.snowColor);
    gl.uniform3fv(loc.uDirtColor, material.dirtColor);
    
    // Material thresholds
    gl.uniform1f(loc.uSnowLine, material.snowLine);
    gl.uniform1f(loc.uRockLine, material.rockLine);
    gl.uniform1f(loc.uMaxGrassSlope, material.maxGrassSlope);
    
    // Terrain params
    gl.uniform1f(loc.uHeightScale, params.noise.heightScale);
    gl.uniform1f(loc.uWorldSize, params.worldSize);
    
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
    
    gl.uniform3fv(loc.uCameraPos, (lightParams as any)?.cameraPos || [0, 0, 5]);
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
    }
    
    if (lightParams?.shadowMap) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, lightParams.shadowMap);
      gl.uniform1i(loc.uShadowMap, 2);
    }
    
    // Draw terrain
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    
    gl.bindVertexArray(null);
  }
  
  private renderOutline(terrain: TerrainObject, vpMatrix: mat4, modelMatrix: mat4): void {
    const vao = terrain.getVAO();
    const indexCount = terrain.getIndexCount();
    if (!vao || indexCount === 0) return;
    
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.outlineProgram);
    gl.bindVertexArray(vao);
    
    gl.uniformMatrix4fv(this.outlineLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(this.outlineLocations.uModel, false, modelMatrix);
    gl.uniform1f(this.outlineLocations.uOutlineWidth, 0.02);
    gl.uniform3fv(this.outlineLocations.uOutlineColor, [1.0, 0.4, 0.2]);
    
    gl.cullFace(gl.FRONT);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    gl.cullFace(gl.BACK);
    
    gl.bindVertexArray(null);
  }
  
  private renderWireframe(terrain: TerrainObject, vpMatrix: mat4, modelMatrix: mat4, isSelected: boolean): void {
    const vao = terrain.getVAO();
    const indexCount = terrain.getIndexCount();
    if (!vao || indexCount === 0) return;
    
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.wireProgram);
    gl.bindVertexArray(vao);
    
    gl.uniformMatrix4fv(this.wireLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniform3fv(this.wireLocations.uColor, isSelected ? [1.0, 0.5, 0.3] : [0.5, 0.7, 0.5]);
    
    // Use LINE mode instead of TRIANGLES for wireframe
    gl.drawElements(gl.LINES, indexCount, gl.UNSIGNED_INT, 0);
    
    gl.bindVertexArray(null);
  }
  
  /**
   * Update clipmap geometry configuration based on terrain parameters
   * Auto-calculates baseScale and ringCount to match terrain's heightmap density
   */
  private updateClipmapForTerrain(worldSize: number, resolution: number): void {
    // Check if we need to rebuild
    if (worldSize === this.lastTerrainWorldSize && resolution === this.lastTerrainResolution) {
      return;
    }
    
    this.lastTerrainWorldSize = worldSize;
    this.lastTerrainResolution = resolution;
    
    // Calculate baseScale to match heightmap texel density
    // baseScale = world units per vertex for innermost ring
    // We want inner ring vertex spacing to match or be finer than heightmap texel spacing
    const heightmapTexelSize = worldSize / resolution;
    const baseScale = heightmapTexelSize;
    
    // Calculate ringCount needed to cover the full terrain
    // Each ring covers (gridSize - 1) * scale units in each direction from center
    // Total coverage from N rings with scale doubling: baseScale * gridSize * (2^N - 1)
    // We want: baseScale * gridSize * (2^N - 1) >= worldSize / 2 (half terrain in each direction)
    const gridSize = 64;
    const halfTerrain = worldSize / 2;
    // Solve: gridSize * baseScale * (2^N - 1) >= halfTerrain
    // 2^N >= halfTerrain / (gridSize * baseScale) + 1
    const minCoverage = halfTerrain / (gridSize * baseScale) + 1;
    const ringCount = Math.max(4, Math.ceil(Math.log2(minCoverage)) + 1);
    
    console.log(`[TerrainRenderer] Updating clipmap for terrain: worldSize=${worldSize}, resolution=${resolution}`);
    console.log(`[TerrainRenderer] Clipmap config: baseScale=${baseScale.toFixed(4)}, ringCount=${ringCount}, gridSize=${gridSize}`);
    
    // Rebuild clipmap geometry with new config
    if (this.clipmapGeometry) {
      this.clipmapGeometry.destroy();
    }
    
    this.clipmapGeometry = new ClipmapGeometry(this.gl, {
      ringCount,
      gridSize,
      baseScale,
    });
  }
  
  /**
   * Render terrain using clipmap (camera-centered LOD rings)
   * Each ring is rendered with heightmap displacement
   */
  renderClipmap(
    terrain: TerrainObject,
    vpMatrix: mat4,
    modelMatrix: mat4,
    cameraPos: [number, number, number],
    isSelected: boolean,
    lightParams: SceneLightingParams | null = null
  ): void {
    if (!terrain.hasGenerated()) return;
    
    const params = terrain.params;
    
    // Auto-configure clipmap based on terrain params
    this.updateClipmapForTerrain(params.worldSize, params.resolution);
    
    if (!this.clipmapGeometry) return;
    
    const heightmapTex = terrain.getHeightmapTexture();
    const erosionTex = terrain.getErosionTexture();
    
    if (!heightmapTex || !erosionTex) {
      // Fall back to standard render if textures not initialized
      this.render(terrain, vpMatrix, modelMatrix, isSelected, false, lightParams);
      return;
    }
    
    const gl = this.gl;
    const loc = this.clipmapLocations;
    const material = terrain.getMaterialParams();
    
    // Calculate terrain bounds (assuming terrain is centered at modelMatrix position)
    const terrainOriginX = modelMatrix[12] - params.worldSize * 0.5;
    const terrainOriginZ = modelMatrix[14] - params.worldSize * 0.5;
    
    gl.useProgram(this.clipmapProgram);
    
    // For clipmap, we render in world space, so use just VP matrix
    // Model matrix is identity since clipmap vertices are already in world space
    const identityModel = mat4.create();
    
    // Matrices
    gl.uniformMatrix4fv(loc.uModelViewProjection, false, vpMatrix as Float32Array);
    gl.uniformMatrix4fv(loc.uModel, false, identityModel);
    
    // Terrain bounds
    gl.uniform2f(loc.uTerrainOrigin, terrainOriginX, terrainOriginZ);
    gl.uniform1f(loc.uTerrainSize, params.worldSize);
    
    // Bind heightmap texture (TEXTURE0)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightmapTex);
    gl.uniform1i(loc.uHeightmap, 0);
    
    // Bind erosion texture (TEXTURE3)
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, erosionTex);
    gl.uniform1i(loc.uErosionMap, 3);
    
    // Heightmap parameters
    gl.uniform1f(loc.uHeightmapResolution, params.resolution);
    gl.uniform1f(loc.uHeightScale, params.noise.heightScale);
    gl.uniform1f(loc.uWorldSize, params.worldSize);
    
    // Material colors
    gl.uniform3fv(loc.uGrassColor, material.grassColor);
    gl.uniform3fv(loc.uRockColor, material.rockColor);
    gl.uniform3fv(loc.uSnowColor, material.snowColor);
    gl.uniform3fv(loc.uDirtColor, material.dirtColor);
    
    // Material thresholds
    gl.uniform1f(loc.uSnowLine, material.snowLine);
    gl.uniform1f(loc.uRockLine, material.rockLine);
    gl.uniform1f(loc.uMaxGrassSlope, material.maxGrassSlope);
    
    // Selection
    gl.uniform1i(loc.uSelected, isSelected ? 1 : 0);
    
    // Lighting setup
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
    
    gl.uniform3fv(loc.uCameraPos, cameraPos);
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
    }
    
    if (lightParams?.shadowMap) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, lightParams.shadowMap);
      gl.uniform1i(loc.uShadowMap, 2);
    }
    
    // Render each clipmap ring from innermost to outermost
    const rings = this.clipmapGeometry.getRings();
    const ringCount = rings.length;
    const config = this.clipmapGeometry.getConfig();
    
    // Set uniforms that are constant across all rings
    gl.uniform1i(loc.uRingCount, ringCount);
    gl.uniform1i(loc.uGridSize, config.gridSize);
    
    for (let i = 0; i < ringCount; i++) {
      const ring = rings[i];
      
      // Snap ring offset to grid to prevent swimming
      const [snappedX, snappedZ] = snapToGrid(cameraPos[0], cameraPos[2], ring.scale);
      
      // Current ring uniforms
      gl.uniform2f(loc.uRingOffset, snappedX, snappedZ);
      gl.uniform1f(loc.uRingScale, ring.scale);
      gl.uniform1i(loc.uRingIndex, i);
      
      // Next ring scale for morphing (coarser LOD)
      // For the outermost ring, use its own scale (no morphing)
      const nextRingScale = (i < ringCount - 1) ? rings[i + 1].scale : ring.scale;
      gl.uniform1f(loc.uNextRingScale, nextRingScale);
      
      gl.bindVertexArray(ring.vao);
      gl.drawElements(gl.TRIANGLES, ring.indexCount, gl.UNSIGNED_INT, 0);
    }
    
    gl.bindVertexArray(null);
  }
  
  /**
   * Clean up GPU resources
   */
  destroy(): void {
    unregisterShader(this.shaderName);
    unregisterShader(this.clipmapShaderName);
    
    const gl = this.gl;
    gl.deleteProgram(this.mainProgram);
    gl.deleteProgram(this.outlineProgram);
    gl.deleteProgram(this.wireProgram);
    gl.deleteProgram(this.clipmapProgram);
    gl.deleteShader(this.mainVs);
    gl.deleteShader(this.mainFs);
    gl.deleteShader(this.outlineVs);
    gl.deleteShader(this.outlineFs);
    gl.deleteShader(this.wireVs);
    gl.deleteShader(this.wireFs);
    gl.deleteShader(this.clipmapVs);
    gl.deleteShader(this.clipmapFs);
    
    if (this.clipmapGeometry) {
      this.clipmapGeometry.destroy();
      this.clipmapGeometry = null;
    }
  }
}

/**
 * TerrainShadowRenderer - Renders terrain to shadow map
 */
export class TerrainShadowRenderer {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private vs: WebGLShader;
  private fs: WebGLShader;
  private locations: {
    aPosition: number;
    uLightSpaceMatrix: WebGLUniformLocation | null;
    uModel: WebGLUniformLocation | null;
  };
  
  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    
    const vsSource = `#version 300 es
    precision highp float;
    
    layout(location = 0) in vec3 aPosition;
    
    uniform mat4 uLightSpaceMatrix;
    uniform mat4 uModel;
    
    void main() {
      gl_Position = uLightSpaceMatrix * uModel * vec4(aPosition, 1.0);
    }`;
    
    const fsSource = `#version 300 es
    precision highp float;
    out vec4 fragColor;
    
    // Pack float depth into RGBA8 (24-bit precision)
    // Must match ShadowRenderer packing format
    vec4 packDepth(float depth) {
      const vec4 bitShift = vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
      const vec4 bitMask = vec4(0.0, 1.0 / 256.0, 1.0 / 256.0, 1.0 / 256.0);
      vec4 res = fract(depth * bitShift);
      res -= res.xxyz * bitMask;
      return res;
    }
    
    void main() {
      // Pack depth into RGBA channels
      fragColor = packDepth(gl_FragCoord.z);
    }`;
    
    this.vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    this.fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    this.program = this.createProgram(this.vs, this.fs);
    
    this.locations = {
      aPosition: gl.getAttribLocation(this.program, 'aPosition'),
      uLightSpaceMatrix: gl.getUniformLocation(this.program, 'uLightSpaceMatrix'),
      uModel: gl.getUniformLocation(this.program, 'uModel'),
    };
  }
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('TerrainShadow shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createProgram(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('TerrainShadow program link error:', gl.getProgramInfoLog(program));
    }
    return program;
  }
  
  render(terrain: TerrainObject, lightSpaceMatrix: mat4, modelMatrix: mat4): void {
    if (!terrain.hasGenerated()) return;
    
    const vao = terrain.getVAO();
    const indexCount = terrain.getIndexCount();
    if (!vao || indexCount === 0) return;
    
    const gl = this.gl;
    
    gl.useProgram(this.program);
    gl.bindVertexArray(vao);
    
    gl.uniformMatrix4fv(this.locations.uLightSpaceMatrix, false, lightSpaceMatrix);
    gl.uniformMatrix4fv(this.locations.uModel, false, modelMatrix);
    
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    
    gl.bindVertexArray(null);
  }
  
  destroy(): void {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteShader(this.vs);
    gl.deleteShader(this.fs);
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new TerrainRenderer(gl)` instead
 */
export function createTerrainRenderer(gl: WebGL2RenderingContext): TerrainRenderer {
  return new TerrainRenderer(gl);
}
