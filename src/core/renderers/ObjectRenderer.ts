/**
 * ObjectRenderer - Renders GLB models with PBR shading, wind effects, and terrain blending
 */

import { mat4 } from 'gl-matrix';
import { registerShader, unregisterShader } from '../../demos/sceneBuilder/shaderManager.js';
import { windComplete, shadowUniforms, shadowFunctions, hdrUniforms, lightingUniforms, pbrFunctions, iblFunctions, pbrLighting, terrainBlendComplete, toneMappingComplete } from '../../demos/sceneBuilder/shaderChunks.js';
import type { GPUMesh } from '../sceneObjects/types';
import type { DirectionalLightParams, SceneLightingParams } from '../sceneObjects/lights';
import type { GLBModel, GLBMesh, GLBMaterial } from '../../loaders';

// Counter for unique renderer IDs
let rendererIdCounter = 0;

/**
 * Wind parameters from wind manager
 */
export interface WindParams {
  enabled: boolean;
  time: number;
  strength: number;
  direction: [number, number];
  turbulence: number;
  debug?: number;
}

/**
 * Per-object wind settings
 */
export interface ObjectWindSettings {
  enabled: boolean;
  influence: number;
  stiffness: number;
  anchorHeight: number;
  leafMaterialIndices?: Set<number>;
  branchMaterialIndices?: Set<number>;
  displacement?: [number, number];
}

/**
 * Terrain blend parameters
 */
export interface TerrainBlendParams {
  enabled: boolean;
  blendDistance?: number;
  depthTexture?: WebGLTexture | null;
  screenSize?: [number, number];
  nearPlane?: number;
  farPlane?: number;
}

/**
 * GPU wireframe data
 */
interface GPUWireframe {
  buffer: WebGLBuffer;
  count: number;
  type: number;
}

/**
 * Shader uniform locations
 */
interface MainShaderLocations {
  aPosition: number;
  aTexCoord: number;
  aNormal: number;
  aTangent: number;
  uHasTangent: WebGLUniformLocation | null;
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uTexture: WebGLUniformLocation | null;
  uBaseColor: WebGLUniformLocation | null;
  uHasTexture: WebGLUniformLocation | null;
  uLightDir: WebGLUniformLocation | null;
  uSelected: WebGLUniformLocation | null;
  uAmbientIntensity: WebGLUniformLocation | null;
  uLightColor: WebGLUniformLocation | null;
  uSkyColor: WebGLUniformLocation | null;
  uGroundColor: WebGLUniformLocation | null;
  uLightMode: WebGLUniformLocation | null;
  uHdrTexture: WebGLUniformLocation | null;
  uHasHdr: WebGLUniformLocation | null;
  uHdrExposure: WebGLUniformLocation | null;
  uLightSpaceMatrix: WebGLUniformLocation | null;
  uShadowMap: WebGLUniformLocation | null;
  uShadowEnabled: WebGLUniformLocation | null;
  uShadowBias: WebGLUniformLocation | null;
  uShadowDebug: WebGLUniformLocation | null;
  uWindDebug: WebGLUniformLocation | null;
  uWindEnabled: WebGLUniformLocation | null;
  uWindTime: WebGLUniformLocation | null;
  uWindStrength: WebGLUniformLocation | null;
  uWindDirection: WebGLUniformLocation | null;
  uWindTurbulence: WebGLUniformLocation | null;
  uWindType: WebGLUniformLocation | null;
  uWindInfluence: WebGLUniformLocation | null;
  uWindStiffness: WebGLUniformLocation | null;
  uWindAnchorHeight: WebGLUniformLocation | null;
  uWindPhysicsDisplacement: WebGLUniformLocation | null;
  uTerrainBlendEnabled: WebGLUniformLocation | null;
  uTerrainBlendDistance: WebGLUniformLocation | null;
  uSceneDepthTexture: WebGLUniformLocation | null;
  uScreenSize: WebGLUniformLocation | null;
  uNearPlane: WebGLUniformLocation | null;
  uFarPlane: WebGLUniformLocation | null;
  uCameraPos: WebGLUniformLocation | null;
  uMetallicRoughnessTexture: WebGLUniformLocation | null;
  uHasMetallicRoughnessTexture: WebGLUniformLocation | null;
  uMetallicFactor: WebGLUniformLocation | null;
  uRoughnessFactor: WebGLUniformLocation | null;
  uNormalTexture: WebGLUniformLocation | null;
  uHasNormalTexture: WebGLUniformLocation | null;
  uNormalScale: WebGLUniformLocation | null;
  uOcclusionTexture: WebGLUniformLocation | null;
  uHasOcclusionTexture: WebGLUniformLocation | null;
  uOcclusionStrength: WebGLUniformLocation | null;
  uEmissiveTexture: WebGLUniformLocation | null;
  uHasEmissiveTexture: WebGLUniformLocation | null;
  uEmissiveFactor: WebGLUniformLocation | null;
  uToneMapping: WebGLUniformLocation | null;
  // Transmission
  uTransmission: WebGLUniformLocation | null;
  uIor: WebGLUniformLocation | null;
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
 * ObjectRenderer - OOP class for rendering GLB models
 */
export class ObjectRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly glbModel: GLBModel;
  private readonly shaderName: string;
  
  // Main shader
  private mainProgram: WebGLProgram;
  private mainVs: WebGLShader;
  private mainFs: WebGLShader;
  private locations: MainShaderLocations;
  
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
  
  // GPU resources
  private gpuWireframes: (GPUWireframe | null)[];
  private gpuTextures: WebGLTexture[];
  
  // Reusable MVP matrix
  private mvpMatrix = mat4.create();
  
  // Public GPU mesh data for shadow rendering
  gpuMeshes: GPUMesh[];

  constructor(gl: WebGL2RenderingContext, glbModel: GLBModel) {
    this.gl = gl;
    this.glbModel = glbModel;
    this.shaderName = `Object Main #${rendererIdCounter++}`;
    
    // Compile main shader
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
    
    // Create GPU buffers for meshes
    this.gpuMeshes = this.createGPUMeshes();
    
    // Create wireframe indices
    this.gpuWireframes = this.createWireframes();
    
    // Create textures with proper color space handling
    this.gpuTextures = this.createTextures();
    
    // Register shader for live editing
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
  }
  
  // ============ Shader Sources ============
  
  private getMainVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    in vec2 aTexCoord;
    in vec3 aNormal;
    in vec4 aTangent;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    uniform bool uHasTangent;
    
    ${windComplete}
    
    out vec2 vTexCoord;
    out vec3 vNormal;
    out vec3 vWorldPos;
    out vec4 vLightSpacePos;
    out float vWindType;
    out float vHeightFactor;
    out float vDisplacementMag;
    out mat3 vTBN;
    out float vHasTangent;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      
      float heightAboveAnchor = max(0.0, worldPos.y - uWindAnchorHeight);
      float heightFactor = clamp(heightAboveAnchor * 0.5, 0.0, 1.0);
      heightFactor = heightFactor * heightFactor;
      
      vec3 windOffset = calcWindDisplacement(worldPos.xyz, heightFactor);
      worldPos.xyz += windOffset;
      
      mat4 invModel = inverse(uModel);
      vec4 displacedLocal = invModel * worldPos;
      
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      vec4 worldOffset = vec4(windOffset, 0.0);
      mat4 vp = uModelViewProjection * inverse(uModel);
      gl_Position += vp * worldOffset;
      
      vTexCoord = aTexCoord;
      vec3 N = normalize(mat3(uModel) * aNormal);
      vNormal = N;
      vWorldPos = worldPos.xyz;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
      
      vHasTangent = uHasTangent ? 1.0 : 0.0;
      if (uHasTangent) {
        vec3 T = normalize(mat3(uModel) * aTangent.xyz);
        T = normalize(T - dot(T, N) * N);
        vec3 B = cross(N, T) * aTangent.w;
        vTBN = mat3(T, B, N);
      } else {
        vTBN = mat3(1.0);
      }
      
      vWindType = float(uWindType);
      vHeightFactor = heightFactor;
      vDisplacementMag = length(windOffset);
    }`;
  }
  
  private getMainFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    uniform sampler2D uTexture;
    uniform sampler2D uMetallicRoughnessTexture;
    uniform sampler2D uNormalTexture;
    uniform sampler2D uOcclusionTexture;
    uniform sampler2D uEmissiveTexture;
    uniform vec4 uBaseColor;
    uniform bool uHasTexture;
    uniform bool uHasMetallicRoughnessTexture;
    uniform bool uHasNormalTexture;
    uniform bool uHasOcclusionTexture;
    uniform bool uHasEmissiveTexture;
    uniform float uMetallicFactor;
    uniform float uRoughnessFactor;
    uniform float uNormalScale;
    uniform float uOcclusionStrength;
    uniform vec3 uEmissiveFactor;
    uniform bool uSelected;
    uniform vec3 uCameraPos;
    
    ${lightingUniforms}
    ${hdrUniforms}
    ${shadowUniforms}
    ${shadowFunctions}
    ${pbrFunctions}
    ${iblFunctions}
    ${pbrLighting}
    
    uniform int uShadowDebug;
    uniform int uWindDebug;
    
    // Transmission uniforms
    uniform float uTransmission;
    uniform float uIor;
    
    ${terrainBlendComplete}
    ${toneMappingComplete}
    
    // Refraction helper using Snell's law
    vec3 calcRefractedRay(vec3 V, vec3 N, float ior) {
      float eta = 1.0 / ior; // Air (1.0) to material
      float cosI = dot(N, V);
      
      // Handle back-facing surfaces
      if (cosI < 0.0) {
        N = -N;
        cosI = -cosI;
        eta = ior; // Material to air
      }
      
      float sinT2 = eta * eta * (1.0 - cosI * cosI);
      
      // Total internal reflection
      if (sinT2 > 1.0) {
        return reflect(-V, N);
      }
      
      float cosT = sqrt(1.0 - sinT2);
      return eta * (-V) + (eta * cosI - cosT) * N;
    }
    
    // Sample environment map with refracted direction
    vec3 sampleEnvMapRefracted(vec3 refractedDir, float roughness) {
      if (uHasHdr == 0) {
        // Fallback to hemisphere color if no HDR
        float skyFactor = refractedDir.y * 0.5 + 0.5;
        return mix(vec3(0.3, 0.25, 0.2), vec3(0.4, 0.6, 1.0), skyFactor) * uAmbientIntensity;
      }
      
      // Convert direction to equirectangular UV
      float phi = atan(refractedDir.z, refractedDir.x);
      float theta = asin(clamp(refractedDir.y, -1.0, 1.0));
      vec2 uv = vec2(phi / (2.0 * 3.14159265) + 0.5, theta / 3.14159265 + 0.5);
      
      // Sample with mip level based on roughness
      float mipLevel = roughness * 6.0;
      vec3 envColor = textureLod(uHdrTexture, uv, mipLevel).rgb;
      
      return envColor * uHdrExposure;
    }
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec3 vWorldPos;
    in vec4 vLightSpacePos;
    in float vWindType;
    in float vHeightFactor;
    in float vDisplacementMag;
    in mat3 vTBN;
    in float vHasTangent;
    
    out vec4 fragColor;
    
    void main() {
      vec4 color = uBaseColor;
      if (uHasTexture) {
        color = texture(uTexture, vTexCoord) * uBaseColor;
      }
      
      vec3 N = normalize(vNormal);
      
      if (uHasNormalTexture) {
        vec3 normalMap = texture(uNormalTexture, vTexCoord).rgb * 2.0 - 1.0;
        normalMap.xy *= uNormalScale;
        
        if (vHasTangent > 0.5) {
          N = normalize(vTBN * normalMap);
        } else {
          vec3 dp1 = dFdx(vWorldPos);
          vec3 dp2 = dFdy(vWorldPos);
          vec2 duv1 = dFdx(vTexCoord);
          vec2 duv2 = dFdy(vTexCoord);
          
          vec3 dp2perp = cross(dp2, N);
          vec3 dp1perp = cross(N, dp1);
          vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
          vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
          
          float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
          mat3 TBN = mat3(T * invmax, B * invmax, N);
          
          N = normalize(TBN * normalMap);
        }
      }
      
      vec3 V = normalize(uCameraPos - vWorldPos);
      vec3 albedo = color.rgb;
      
      float metallic = uMetallicFactor;
      float roughness = uRoughnessFactor;
      if (uHasMetallicRoughnessTexture) {
        vec4 mrSample = texture(uMetallicRoughnessTexture, vTexCoord);
        roughness *= mrSample.g;
        metallic *= mrSample.b;
      }
      
      float ao = 1.0;
      if (uHasOcclusionTexture) {
        ao = texture(uOcclusionTexture, vTexCoord).r;
        ao = mix(1.0, ao, uOcclusionStrength);
      }
      
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        albedo, metallic, roughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      finalColor *= ao;
      
      if (uHasEmissiveTexture) {
        vec3 emissive = texture(uEmissiveTexture, vTexCoord).rgb * uEmissiveFactor;
        finalColor += emissive;
      } else if (length(uEmissiveFactor) > 0.0) {
        finalColor += uEmissiveFactor;
      }
      
      finalColor = applyToneMapping(finalColor, uToneMapping);
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
      // Debug visualizations
      if (uShadowDebug == 1) {
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        vec4 packed = texture(uShadowMap, projCoords.xy);
        float depth = unpackDepth(packed);
        vec4 centerPacked = texture(uShadowMap, vec2(0.5, 0.5));
        float centerDepth = unpackDepth(centerPacked);
        fragColor = vec4(centerDepth, depth, packed.a, 1.0);
        return;
      } else if (uShadowDebug == 2) {
        vec3 projCoords = (vLightSpacePos.xyz / vLightSpacePos.w) * 0.5 + 0.5;
        fragColor = vec4(projCoords.xy, projCoords.z, 1.0);
        return;
      } else if (uShadowDebug == 3) {
        vec3 lightDir = normalize(uLightDir);
        float shadowVal = calcShadow(vLightSpacePos, N, lightDir);
        fragColor = vec4(vec3(shadowVal), 1.0);
        return;
      }
      
      if (uWindDebug == 1) {
        vec3 debugColor;
        if (vWindType < 0.5) debugColor = vec3(1.0, 0.0, 0.0);
        else if (vWindType < 1.5) debugColor = vec3(0.0, 1.0, 0.0);
        else debugColor = vec3(1.0, 1.0, 0.0);
        fragColor = vec4(debugColor, 1.0);
        return;
      } else if (uWindDebug == 2) {
        fragColor = vec4(vec3(vHeightFactor), 1.0);
        return;
      } else if (uWindDebug == 3) {
        float normalizedDisp = clamp(vDisplacementMag * 5.0, 0.0, 1.0);
        vec3 debugColor = mix(vec3(0.0, 0.0, 1.0), vec3(1.0, 0.0, 0.0), normalizedDisp);
        fragColor = vec4(debugColor, 1.0);
        return;
      }
      
      // Apply transmission (environment map refraction)
      float finalAlpha = color.a;
      if (uTransmission > 0.0) {
        // Calculate refracted ray
        vec3 refractedDir = calcRefractedRay(V, N, uIor);
        
        // Sample environment with refracted direction
        vec3 transmittedColor = sampleEnvMapRefracted(refractedDir, roughness);
        
        // Fresnel effect - more reflection at grazing angles
        float NdotV = max(dot(N, V), 0.0);
        float fresnelFactor = pow(1.0 - NdotV, 5.0);
        float effectiveTransmission = uTransmission * (1.0 - fresnelFactor * 0.5);
        
        // Blend transmitted color with surface color
        // For high transmission, the surface becomes mostly transparent
        finalColor = mix(finalColor, transmittedColor, effectiveTransmission);
        
        // Adjust alpha for blending (optional, for partial transparency)
        finalAlpha = mix(finalAlpha, 1.0, effectiveTransmission);
      }
      
      vec4 finalFragment = vec4(finalColor, finalAlpha);
      
      if (uTerrainBlendEnabled == 1) {
        finalFragment = applyTerrainBlend(finalFragment, gl_FragCoord.z);
      }
      
      fragColor = finalFragment;
    }`;
  }
  
  // ============ Shader Compilation ============
  
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
    }
    return shader;
  }
  
  private createProgram(vs: WebGLShader, fs: WebGLShader): WebGLProgram {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
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
    in vec3 aPosition;
    in vec3 aNormal;
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
    in vec3 aPosition;
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
  
  // ============ Uniform Locations ============
  
  private getMainLocations(): MainShaderLocations {
    const gl = this.gl;
    const p = this.mainProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aTexCoord: gl.getAttribLocation(p, 'aTexCoord'),
      aNormal: gl.getAttribLocation(p, 'aNormal'),
      aTangent: gl.getAttribLocation(p, 'aTangent'),
      uHasTangent: gl.getUniformLocation(p, 'uHasTangent'),
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uTexture: gl.getUniformLocation(p, 'uTexture'),
      uBaseColor: gl.getUniformLocation(p, 'uBaseColor'),
      uHasTexture: gl.getUniformLocation(p, 'uHasTexture'),
      uLightDir: gl.getUniformLocation(p, 'uLightDir'),
      uSelected: gl.getUniformLocation(p, 'uSelected'),
      uAmbientIntensity: gl.getUniformLocation(p, 'uAmbientIntensity'),
      uLightColor: gl.getUniformLocation(p, 'uLightColor'),
      uSkyColor: gl.getUniformLocation(p, 'uSkyColor'),
      uGroundColor: gl.getUniformLocation(p, 'uGroundColor'),
      uLightMode: gl.getUniformLocation(p, 'uLightMode'),
      uHdrTexture: gl.getUniformLocation(p, 'uHdrTexture'),
      uHasHdr: gl.getUniformLocation(p, 'uHasHdr'),
      uHdrExposure: gl.getUniformLocation(p, 'uHdrExposure'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
      uShadowMap: gl.getUniformLocation(p, 'uShadowMap'),
      uShadowEnabled: gl.getUniformLocation(p, 'uShadowEnabled'),
      uShadowBias: gl.getUniformLocation(p, 'uShadowBias'),
      uShadowDebug: gl.getUniformLocation(p, 'uShadowDebug'),
      uWindDebug: gl.getUniformLocation(p, 'uWindDebug'),
      uWindEnabled: gl.getUniformLocation(p, 'uWindEnabled'),
      uWindTime: gl.getUniformLocation(p, 'uWindTime'),
      uWindStrength: gl.getUniformLocation(p, 'uWindStrength'),
      uWindDirection: gl.getUniformLocation(p, 'uWindDirection'),
      uWindTurbulence: gl.getUniformLocation(p, 'uWindTurbulence'),
      uWindType: gl.getUniformLocation(p, 'uWindType'),
      uWindInfluence: gl.getUniformLocation(p, 'uWindInfluence'),
      uWindStiffness: gl.getUniformLocation(p, 'uWindStiffness'),
      uWindAnchorHeight: gl.getUniformLocation(p, 'uWindAnchorHeight'),
      uWindPhysicsDisplacement: gl.getUniformLocation(p, 'uWindPhysicsDisplacement'),
      uTerrainBlendEnabled: gl.getUniformLocation(p, 'uTerrainBlendEnabled'),
      uTerrainBlendDistance: gl.getUniformLocation(p, 'uTerrainBlendDistance'),
      uSceneDepthTexture: gl.getUniformLocation(p, 'uSceneDepthTexture'),
      uScreenSize: gl.getUniformLocation(p, 'uScreenSize'),
      uNearPlane: gl.getUniformLocation(p, 'uNearPlane'),
      uFarPlane: gl.getUniformLocation(p, 'uFarPlane'),
      uCameraPos: gl.getUniformLocation(p, 'uCameraPos'),
      uMetallicRoughnessTexture: gl.getUniformLocation(p, 'uMetallicRoughnessTexture'),
      uHasMetallicRoughnessTexture: gl.getUniformLocation(p, 'uHasMetallicRoughnessTexture'),
      uMetallicFactor: gl.getUniformLocation(p, 'uMetallicFactor'),
      uRoughnessFactor: gl.getUniformLocation(p, 'uRoughnessFactor'),
      uNormalTexture: gl.getUniformLocation(p, 'uNormalTexture'),
      uHasNormalTexture: gl.getUniformLocation(p, 'uHasNormalTexture'),
      uNormalScale: gl.getUniformLocation(p, 'uNormalScale'),
      uOcclusionTexture: gl.getUniformLocation(p, 'uOcclusionTexture'),
      uHasOcclusionTexture: gl.getUniformLocation(p, 'uHasOcclusionTexture'),
      uOcclusionStrength: gl.getUniformLocation(p, 'uOcclusionStrength'),
      uEmissiveTexture: gl.getUniformLocation(p, 'uEmissiveTexture'),
      uHasEmissiveTexture: gl.getUniformLocation(p, 'uHasEmissiveTexture'),
      uEmissiveFactor: gl.getUniformLocation(p, 'uEmissiveFactor'),
      uToneMapping: gl.getUniformLocation(p, 'uToneMapping'),
      // Transmission
      uTransmission: gl.getUniformLocation(p, 'uTransmission'),
      uIor: gl.getUniformLocation(p, 'uIor'),
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
  
  // ============ GPU Resource Creation ============
  
  private createGPUMeshes(): GPUMesh[] {
    const gl = this.gl;
    
    return this.glbModel.meshes.map((mesh: GLBMesh) => {
      const posBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
      
      let uvBuffer: WebGLBuffer | null = null;
      if (mesh.uvs) {
        uvBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);
      }
      
      let normalBuffer: WebGLBuffer | null = null;
      if (mesh.normals) {
        normalBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
      }
      
      let tangentBuffer: WebGLBuffer | null = null;
      if (mesh.tangents) {
        tangentBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, tangentBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.tangents, gl.STATIC_DRAW);
      }
      
      let indexBuffer: WebGLBuffer | null = null;
      let indexCount = 0;
      let indexType: GPUMesh['indexType'] = gl.UNSIGNED_SHORT;
      if (mesh.indices) {
        indexBuffer = gl.createBuffer()!;
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        if (mesh.indices instanceof Uint32Array) {
          indexType = gl.UNSIGNED_INT;
        }
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
        indexCount = mesh.indices.length;
      }
      
      return {
        posBuffer,
        uvBuffer,
        normalBuffer,
        tangentBuffer,
        indexBuffer,
        indexCount,
        indexType,
        vertexCount: mesh.positions?.length ? mesh.positions.length / 3 : 0,
        materialIndex: mesh.materialIndex ?? 0,
      } as GPUMesh;
    });
  }
  
  private createWireframes(): (GPUWireframe | null)[] {
    const gl = this.gl;
    
    return this.gpuMeshes.map((gpuMesh, meshIndex) => {
      const mesh = this.glbModel.meshes[meshIndex];
      if (!mesh.indices) return null;
      
      const edgeSet = new Set<string>();
      const indices = mesh.indices;
      
      for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i], i1 = indices[i + 1], i2 = indices[i + 2];
        edgeSet.add(i0 < i1 ? `${i0}-${i1}` : `${i1}-${i0}`);
        edgeSet.add(i1 < i2 ? `${i1}-${i2}` : `${i2}-${i1}`);
        edgeSet.add(i2 < i0 ? `${i2}-${i0}` : `${i0}-${i2}`);
      }
      
      const lineIndices: number[] = [];
      for (const edge of edgeSet) {
        const [a, b] = edge.split('-').map(Number);
        lineIndices.push(a, b);
      }
      
      const wireIndexBuffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIndexBuffer);
      const wireIndexArray = mesh.indices instanceof Uint32Array 
        ? new Uint32Array(lineIndices)
        : new Uint16Array(lineIndices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wireIndexArray, gl.STATIC_DRAW);
      
      return {
        buffer: wireIndexBuffer,
        count: lineIndices.length,
        type: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      };
    });
  }
  
  private createTextures(): WebGLTexture[] {
    const gl = this.gl;
    
    // Identify sRGB textures (base color, emissive)
    const srgbTextureIndices = new Set<number>();
    for (const material of this.glbModel.materials) {
      if (material.baseColorTextureIndex !== undefined) {
        srgbTextureIndices.add(material.baseColorTextureIndex);
      }
      if (material.emissiveTextureIndex !== undefined) {
        srgbTextureIndices.add(material.emissiveTextureIndex);
      }
    }
    
    return this.glbModel.textures.map((imageData, index) => {
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      
      const isSrgb = srgbTextureIndices.has(index);
      const internalFormat = isSrgb ? gl.SRGB8_ALPHA8 : gl.RGBA;
      
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, gl.RGBA, gl.UNSIGNED_BYTE, imageData);
      gl.generateMipmap(gl.TEXTURE_2D);
      
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      
      return texture;
    });
  }
  
  // ============ Rendering ============
  
  private renderOutline(vpMatrix: mat4, modelMatrix: mat4): void {
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.outlineProgram);
    gl.uniformMatrix4fv(this.outlineLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(this.outlineLocations.uModel, false, modelMatrix);
    gl.uniform1f(this.outlineLocations.uOutlineWidth, 0.01);
    gl.uniform3fv(this.outlineLocations.uOutlineColor, [1.0, 0.4, 0.2]);
    
    gl.cullFace(gl.FRONT);
    
    for (const gpuMesh of this.gpuMeshes) {
      gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
      gl.enableVertexAttribArray(this.outlineLocations.aPosition);
      gl.vertexAttribPointer(this.outlineLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (gpuMesh.normalBuffer && this.outlineLocations.aNormal >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.normalBuffer);
        gl.enableVertexAttribArray(this.outlineLocations.aNormal);
        gl.vertexAttribPointer(this.outlineLocations.aNormal, 3, gl.FLOAT, false, 0, 0);
      }
      
      if (gpuMesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpuMesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, gpuMesh.indexCount, gpuMesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, gpuMesh.vertexCount);
      }
    }
    
    gl.cullFace(gl.BACK);
  }
  
  private renderWireframe(vpMatrix: mat4, modelMatrix: mat4, isSelected: boolean): void {
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.wireProgram);
    gl.uniformMatrix4fv(this.wireLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniform3fv(this.wireLocations.uColor, isSelected ? [1.0, 0.5, 0.3] : [0.7, 0.7, 0.7]);
    
    for (let i = 0; i < this.gpuMeshes.length; i++) {
      const gpuMesh = this.gpuMeshes[i];
      const wireframe = this.gpuWireframes[i];
      if (!wireframe) continue;
      
      gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
      gl.enableVertexAttribArray(this.wireLocations.aPosition);
      gl.vertexAttribPointer(this.wireLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireframe.buffer);
      gl.drawElements(gl.LINES, wireframe.count, wireframe.type, 0);
    }
  }
  
  // ============ Public API ============
  
  render(
    vpMatrix: mat4,
    modelMatrix: mat4,
    isSelected: boolean,
    wireframeMode = false,
    lightParams: SceneLightingParams | null = null,
    windParams: WindParams | null = null,
    objectWindSettings: ObjectWindSettings | null = null,
    terrainBlendParams: TerrainBlendParams | null = null
  ): void {
    if (wireframeMode) {
      this.renderWireframe(vpMatrix, modelMatrix, isSelected);
      return;
    }
    
    if (isSelected) {
      this.renderOutline(vpMatrix, modelMatrix);
    }
    
    const gl = this.gl;
    const loc = this.locations;
    
    // Create a default light if none provided
    const light = lightParams;
    
    // Extract light direction and color based on type
    let lightDir: number[] = [0.5, 1, 0.5];
    let lightColor: number[] = [1, 1, 1];
    let lightMode = 0; // 0 = directional, 1 = hdr
    let ambient = 0.3;
    
    if (light) {
      if (light.type === 'directional') {
        const dirLight = light as DirectionalLightParams;
        lightDir = [...dirLight.direction];
        lightColor = dirLight.effectiveColor;
        ambient = dirLight.ambient;
      } else if (light.type === 'hdr') {
        lightMode = 1;
        ambient = light.ambient;
      }
    }
    
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.mainProgram);
    gl.uniformMatrix4fv(loc.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(loc.uModel, false, modelMatrix);
    gl.uniform3fv(loc.uLightDir, lightDir as any);
    gl.uniform1i(loc.uSelected, isSelected ? 1 : 0);
    gl.uniform1f(loc.uAmbientIntensity, ambient);
    gl.uniform3fv(loc.uLightColor, lightColor as any);
    
    // Get sky/ground colors from directional light if available
    const dirParams = light?.type === 'directional' ? light as DirectionalLightParams : null;
    gl.uniform3fv(loc.uSkyColor, dirParams?.skyColor || [0.4, 0.6, 1.0]);
    gl.uniform3fv(loc.uGroundColor, dirParams?.groundColor || [0.3, 0.25, 0.2]);
    
    gl.uniform1i(loc.uLightMode, lightMode);
    
    // HDR params
    const hdrTexture = light?.type === 'hdr' ? (light as any).hdrTexture : null;
    const hdrExposure = light?.type === 'hdr' ? (light as any).exposure : 1.0;
    gl.uniform1i(loc.uHasHdr, hdrTexture ? 1 : 0);
    gl.uniform1f(loc.uHdrExposure, hdrExposure);
    
    gl.uniform3fv(loc.uCameraPos, (light as any)?.cameraPos || [0, 0, 5]);
    gl.uniform1i(loc.uToneMapping, light?.toneMapping !== undefined ? light.toneMapping : 3);
    
    // Shadow uniforms
    gl.uniform1i(loc.uShadowEnabled, light?.shadowEnabled ? 1 : 0);
    gl.uniform1f(loc.uShadowBias, light?.shadowBias || 0.002);
    gl.uniform1i(loc.uShadowDebug, light?.shadowDebug || 0);
    if (light?.lightSpaceMatrix) {
      gl.uniformMatrix4fv(loc.uLightSpaceMatrix, false, light.lightSpaceMatrix as Float32Array);
    }
    
    gl.activeTexture(gl.TEXTURE2);
    if (light?.shadowMap) {
      gl.bindTexture(gl.TEXTURE_2D, light.shadowMap);
    }
    gl.uniform1i(loc.uShadowMap, 2);
    
    if (hdrTexture) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, hdrTexture);
      gl.uniform1i(loc.uHdrTexture, 1);
    }
    
    // Wind uniforms
    const wind = windParams || { enabled: false, time: 0, strength: 0, direction: [1, 0] as [number, number], turbulence: 0.5, debug: 0 };
    const objWind = objectWindSettings || { enabled: false, influence: 1.0, stiffness: 0.5, anchorHeight: 0 };
    
    gl.uniform1i(loc.uWindDebug, wind.debug || 0);
    
    const windActive = wind.enabled && objWind.enabled;
    gl.uniform1i(loc.uWindEnabled, windActive ? 1 : 0);
    gl.uniform1f(loc.uWindTime, wind.time || 0);
    gl.uniform1f(loc.uWindStrength, wind.strength || 0);
    gl.uniform2fv(loc.uWindDirection, wind.direction || [1, 0]);
    gl.uniform1f(loc.uWindTurbulence, wind.turbulence || 0.5);
    gl.uniform1f(loc.uWindInfluence, objWind.influence || 1.0);
    gl.uniform1f(loc.uWindStiffness, objWind.stiffness || 0.5);
    gl.uniform1f(loc.uWindAnchorHeight, objWind.anchorHeight || 0);
    gl.uniform2fv(loc.uWindPhysicsDisplacement, objWind.displacement || [0, 0]);
    
    // Terrain blend uniforms
    const terrainBlend = terrainBlendParams || { enabled: false };
    gl.uniform1i(loc.uTerrainBlendEnabled, terrainBlend.enabled ? 1 : 0);
    gl.uniform1f(loc.uTerrainBlendDistance, terrainBlend.blendDistance || 0.5);
    gl.uniform2fv(loc.uScreenSize, terrainBlend.screenSize || [800, 600]);
    gl.uniform1f(loc.uNearPlane, terrainBlend.nearPlane || 0.1);
    gl.uniform1f(loc.uFarPlane, terrainBlend.farPlane || 100.0);
    
    if (terrainBlend.enabled && terrainBlend.depthTexture) {
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, terrainBlend.depthTexture);
      gl.uniform1i(loc.uSceneDepthTexture, 3);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    
    // Render each mesh
    for (let meshIdx = 0; meshIdx < this.gpuMeshes.length; meshIdx++) {
      const gpuMesh = this.gpuMeshes[meshIdx];
      
      // Determine wind type
      let windType = 0;
      if (windActive) {
        if (objWind.leafMaterialIndices?.has(gpuMesh.materialIndex)) {
          windType = 1;
        } else if (objWind.branchMaterialIndices?.has(gpuMesh.materialIndex)) {
          windType = 2;
        }
      }
      gl.uniform1i(loc.uWindType, windType);
      
      gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.posBuffer);
      gl.enableVertexAttribArray(loc.aPosition);
      gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
      
      if (gpuMesh.uvBuffer && loc.aTexCoord >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.uvBuffer);
        gl.enableVertexAttribArray(loc.aTexCoord);
        gl.vertexAttribPointer(loc.aTexCoord, 2, gl.FLOAT, false, 0, 0);
      }
      
      if (gpuMesh.normalBuffer && loc.aNormal >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.normalBuffer);
        gl.enableVertexAttribArray(loc.aNormal);
        gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
      }
      
      if (gpuMesh.tangentBuffer && loc.aTangent >= 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, gpuMesh.tangentBuffer);
        gl.enableVertexAttribArray(loc.aTangent);
        gl.vertexAttribPointer(loc.aTangent, 4, gl.FLOAT, false, 0, 0);
        gl.uniform1i(loc.uHasTangent, 1);
      } else {
        if (loc.aTangent >= 0) {
          gl.disableVertexAttribArray(loc.aTangent);
        }
        gl.uniform1i(loc.uHasTangent, 0);
      }
      
      const material = this.glbModel.materials[gpuMesh.materialIndex] || { 
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0.0,
        roughnessFactor: 0.5
      };
      gl.uniform4fv(loc.uBaseColor, material.baseColorFactor);
      gl.uniform1f(loc.uMetallicFactor, material.metallicFactor ?? 0.0);
      gl.uniform1f(loc.uRoughnessFactor, material.roughnessFactor ?? 0.5);
      
      // Base color texture
      if (material.baseColorTextureIndex !== undefined && this.gpuTextures[material.baseColorTextureIndex]) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[material.baseColorTextureIndex]);
        gl.uniform1i(loc.uTexture, 0);
        gl.uniform1i(loc.uHasTexture, 1);
      } else {
        gl.uniform1i(loc.uHasTexture, 0);
      }
      
      // Metallic-roughness texture
      if (material.metallicRoughnessTextureIndex !== undefined && this.gpuTextures[material.metallicRoughnessTextureIndex]) {
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[material.metallicRoughnessTextureIndex]);
        gl.uniform1i(loc.uMetallicRoughnessTexture, 4);
        gl.uniform1i(loc.uHasMetallicRoughnessTexture, 1);
      } else {
        gl.uniform1i(loc.uHasMetallicRoughnessTexture, 0);
      }
      
      // Normal map
      if (material.normalTextureIndex !== undefined && this.gpuTextures[material.normalTextureIndex]) {
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[material.normalTextureIndex]);
        gl.uniform1i(loc.uNormalTexture, 5);
        gl.uniform1i(loc.uHasNormalTexture, 1);
        gl.uniform1f(loc.uNormalScale, material.normalScale ?? 1.0);
      } else {
        gl.uniform1i(loc.uHasNormalTexture, 0);
        gl.uniform1f(loc.uNormalScale, 1.0);
      }
      
      // Occlusion
      if (material.occlusionTextureIndex !== undefined && this.gpuTextures[material.occlusionTextureIndex]) {
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[material.occlusionTextureIndex]);
        gl.uniform1i(loc.uOcclusionTexture, 6);
        gl.uniform1i(loc.uHasOcclusionTexture, 1);
        gl.uniform1f(loc.uOcclusionStrength, material.occlusionStrength ?? 1.0);
      } else {
        gl.uniform1i(loc.uHasOcclusionTexture, 0);
        gl.uniform1f(loc.uOcclusionStrength, 1.0);
      }
      
      // Emissive
      if (material.emissiveTextureIndex !== undefined && this.gpuTextures[material.emissiveTextureIndex]) {
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, this.gpuTextures[material.emissiveTextureIndex]);
        gl.uniform1i(loc.uEmissiveTexture, 7);
        gl.uniform1i(loc.uHasEmissiveTexture, 1);
        gl.uniform3fv(loc.uEmissiveFactor, material.emissiveFactor || [1, 1, 1]);
      } else {
        gl.uniform1i(loc.uHasEmissiveTexture, 0);
        gl.uniform3fv(loc.uEmissiveFactor, material.emissiveFactor || [0, 0, 0]);
      }
      
      // Transmission (KHR_materials_transmission)
      gl.uniform1f(loc.uTransmission, (material as GLBMaterial).transmission ?? 0.0);
      gl.uniform1f(loc.uIor, (material as GLBMaterial).ior ?? 1.5);
      
      if (gpuMesh.indexBuffer) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpuMesh.indexBuffer);
        gl.drawElements(gl.TRIANGLES, gpuMesh.indexCount, gpuMesh.indexType, 0);
      } else {
        gl.drawArrays(gl.TRIANGLES, 0, gpuMesh.vertexCount);
      }
    }
    
    if (terrainBlend.enabled) {
      gl.disable(gl.BLEND);
    }
  }
  
  destroy(): void {
    unregisterShader(this.shaderName);
    
    const gl = this.gl;
    gl.deleteProgram(this.mainProgram);
    gl.deleteProgram(this.outlineProgram);
    gl.deleteProgram(this.wireProgram);
    gl.deleteShader(this.mainVs);
    gl.deleteShader(this.mainFs);
    gl.deleteShader(this.outlineVs);
    gl.deleteShader(this.outlineFs);
    gl.deleteShader(this.wireVs);
    gl.deleteShader(this.wireFs);
    
    this.gpuMeshes.forEach(m => {
      gl.deleteBuffer(m.posBuffer);
      if (m.uvBuffer) gl.deleteBuffer(m.uvBuffer);
      if (m.normalBuffer) gl.deleteBuffer(m.normalBuffer);
      if (m.tangentBuffer) gl.deleteBuffer(m.tangentBuffer);
      if (m.indexBuffer) gl.deleteBuffer(m.indexBuffer);
    });
    
    this.gpuWireframes.forEach(w => {
      if (w) gl.deleteBuffer(w.buffer);
    });
    
    this.gpuTextures.forEach(t => gl.deleteTexture(t));
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new ObjectRenderer(gl, glbModel)` instead
 */
export function createObjectRenderer(gl: WebGL2RenderingContext, glbModel: GLBModel): ObjectRenderer {
  return new ObjectRenderer(gl, glbModel);
}
