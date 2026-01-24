/**
 * PrimitiveRenderer - Renders primitive geometry (cube, plane, sphere) with PBR shading
 */

import { mat4 } from 'gl-matrix';
import { generatePrimitiveGeometry, computeBounds } from '../utils/primitiveGeometry';
import { shadowUniforms, shadowFunctions, hdrUniforms, lightingUniforms, pbrFunctions, iblFunctions, pbrLighting, toneMappingComplete } from '../../demos/sceneBuilder/shaderChunks.js';
import { registerShader, unregisterShader } from '../../demos/sceneBuilder/shaderManager.js';
import type { 
  IPrimitiveRenderer, 
  PrimitiveConfig, 
  PrimitiveType, 
  PBRMaterial, 
  GPUMesh, 
  AABB,
  GeometryData,
} from '../sceneObjects/types';
import type { SceneLightingParams } from '../../core/sceneObjects/lights';
import type { DirectionalLightParams } from '../sceneObjects/lights';

// Counter for unique shader names
let primitiveShaderCounter = 0;

/**
 * Shader uniform locations type
 */
interface ShaderLocations {
  aPosition: number;
  aTexCoord: number;
  aNormal: number;
  uModelViewProjection: WebGLUniformLocation | null;
  uModel: WebGLUniformLocation | null;
  uAlbedo: WebGLUniformLocation | null;
  uMetallic: WebGLUniformLocation | null;
  uRoughness: WebGLUniformLocation | null;
  uCameraPos: WebGLUniformLocation | null;
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
  uHdrMaxMipLevel: WebGLUniformLocation | null;
  uLightSpaceMatrix: WebGLUniformLocation | null;
  uShadowMap: WebGLUniformLocation | null;
  uShadowEnabled: WebGLUniformLocation | null;
  uToneMapping: WebGLUniformLocation | null;
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

interface Geometry {
  positions: Float32Array;
  uvs: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
}

/**
 * PrimitiveRenderer - OOP class for rendering primitive geometry
 */
export class PrimitiveRenderer implements IPrimitiveRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly primitiveType: PrimitiveType;
  private readonly isSingleSided: boolean;
  private readonly shaderName: string;
  
  // Material
  private material: PBRMaterial = {
    albedo: [0.75, 0.75, 0.75],
    metallic: 0.0,
    roughness: 0.5,
  };
  
  // Geometry
  private geometry: Geometry;
  private config: PrimitiveConfig;
  
  // Main shader
  private mainProgram: WebGLProgram;
  private mainVs: WebGLShader;
  private mainFs: WebGLShader;
  private locations: ShaderLocations;
  
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
  
  // Buffers
  private posBuffer: WebGLBuffer;
  private uvBuffer: WebGLBuffer;
  private normalBuffer: WebGLBuffer;
  private indexBuffer: WebGLBuffer;
  private wireIndexBuffer: WebGLBuffer;
  private normalLineBuffer: WebGLBuffer;
  
  // Counts
  private indexCount = 0;
  private wireIndexCount = 0;
  private normalLineCount = 0;
  
  // State
  private _isDestroyed = false;
  
  // MVP matrix (reused)
  private mvpMatrix = mat4.create();
  
  // Public GPU mesh data for shadow rendering
  gpuMeshes: GPUMesh[];

  constructor(
    gl: WebGL2RenderingContext, 
    primitiveType: PrimitiveType, 
    config: PrimitiveConfig = {}
  ) {
    this.gl = gl;
    this.primitiveType = primitiveType;
    this.config = { ...config };
    this.isSingleSided = primitiveType === 'plane';
    this.shaderName = `Primitive ${primitiveType} #${primitiveShaderCounter++}`;
    
    // Generate initial geometry
    this.geometry = generatePrimitiveGeometry(primitiveType, this.config);
    
    // Compile shaders and create programs
    const { program: mainProg, vs: mainV, fs: mainF } = this.createMainShader();
    this.mainProgram = mainProg;
    this.mainVs = mainV;
    this.mainFs = mainF;
    this.locations = this.getMainLocations();
    
    const { program: outlineProg, vs: outlineV, fs: outlineF } = this.createOutlineShader();
    this.outlineProgram = outlineProg;
    this.outlineVs = outlineV;
    this.outlineFs = outlineF;
    this.outlineLocations = this.getOutlineLocations();
    
    const { program: wireProg, vs: wireV, fs: wireF } = this.createWireShader();
    this.wireProgram = wireProg;
    this.wireVs = wireV;
    this.wireFs = wireF;
    this.wireLocations = this.getWireLocations();
    
    // Create buffers
    this.posBuffer = gl.createBuffer()!;
    this.uvBuffer = gl.createBuffer()!;
    this.normalBuffer = gl.createBuffer()!;
    this.indexBuffer = gl.createBuffer()!;
    this.wireIndexBuffer = gl.createBuffer()!;
    this.normalLineBuffer = gl.createBuffer()!;
    
    // Upload geometry
    this.uploadGeometry();
    this.uploadWireframe();
    this.uploadNormalLines();
    
    // Initialize gpuMeshes for shadow rendering
    this.gpuMeshes = [{
      posBuffer: this.posBuffer,
      normalBuffer: this.normalBuffer,
      indexBuffer: this.indexBuffer,
      indexCount: this.indexCount,
      indexType: gl.UNSIGNED_SHORT,
      vertexCount: this.geometry.positions.length / 3,
      materialIndex: 0,
    }];
    
    // Register shader for live editing
    registerShader(this.shaderName, {
      gl,
      program: this.mainProgram,
      vsSource: this.getMainVsSource(),
      fsSource: this.getMainFsSource(),
      onRecompile: (newProgram: WebGLProgram) => {
        this.mainProgram = newProgram;
        this.locations = this.getMainLocations();
      },
    });
  }
  
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }
  
  // ============ Shader Sources ============
  
  private getMainVsSource(): string {
    return `#version 300 es
    precision highp float;
    
    in vec3 aPosition;
    in vec2 aTexCoord;
    in vec3 aNormal;
    
    uniform mat4 uModelViewProjection;
    uniform mat4 uModel;
    uniform mat4 uLightSpaceMatrix;
    
    out vec2 vTexCoord;
    out vec3 vNormal;
    out vec3 vWorldPos;
    out vec4 vLightSpacePos;
    
    void main() {
      vec4 worldPos = uModel * vec4(aPosition, 1.0);
      gl_Position = uModelViewProjection * vec4(aPosition, 1.0);
      
      vTexCoord = aTexCoord;
      vNormal = mat3(uModel) * aNormal;
      vWorldPos = worldPos.xyz;
      vLightSpacePos = uLightSpaceMatrix * worldPos;
    }`;
  }
  
  private getMainFsSource(): string {
    return `#version 300 es
    precision highp float;
    
    uniform vec3 uAlbedo;
    uniform float uMetallic;
    uniform float uRoughness;
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
    
    in vec2 vTexCoord;
    in vec3 vNormal;
    in vec3 vWorldPos;
    in vec4 vLightSpacePos;
    
    out vec4 fragColor;
    
    void main() {
      vec3 N = normalize(vNormal);
      vec3 V = normalize(uCameraPos - vWorldPos);
      
      vec3 finalColor = calcPBRLighting(
        N, V, vWorldPos,
        uAlbedo, uMetallic, uRoughness,
        uLightDir, uLightColor, uAmbientIntensity,
        uLightMode, uHdrTexture, uHasHdr, uHdrExposure,
        uShadowMap, uShadowEnabled, vLightSpacePos
      );
      
      finalColor = applyToneMapping(finalColor, uToneMapping);
      finalColor = pow(finalColor, vec3(1.0 / 2.2));
      
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
  
  private getMainLocations(): ShaderLocations {
    const gl = this.gl;
    const p = this.mainProgram;
    return {
      aPosition: gl.getAttribLocation(p, 'aPosition'),
      aTexCoord: gl.getAttribLocation(p, 'aTexCoord'),
      aNormal: gl.getAttribLocation(p, 'aNormal'),
      uModelViewProjection: gl.getUniformLocation(p, 'uModelViewProjection'),
      uModel: gl.getUniformLocation(p, 'uModel'),
      uAlbedo: gl.getUniformLocation(p, 'uAlbedo'),
      uMetallic: gl.getUniformLocation(p, 'uMetallic'),
      uRoughness: gl.getUniformLocation(p, 'uRoughness'),
      uCameraPos: gl.getUniformLocation(p, 'uCameraPos'),
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
      uHdrMaxMipLevel: gl.getUniformLocation(p, 'uHdrMaxMipLevel'),
      uLightSpaceMatrix: gl.getUniformLocation(p, 'uLightSpaceMatrix'),
      uShadowMap: gl.getUniformLocation(p, 'uShadowMap'),
      uShadowEnabled: gl.getUniformLocation(p, 'uShadowEnabled'),
      uToneMapping: gl.getUniformLocation(p, 'uToneMapping'),
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
  
  // ============ Geometry Upload ============
  
  private uploadGeometry(): void {
    const gl = this.gl;
    const g = this.geometry;
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, g.positions, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, g.uvs, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, g.normals, gl.STATIC_DRAW);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    
    this.indexCount = g.indices.length;
  }
  
  private generateWireframeIndices(): Uint16Array {
    const indices = this.geometry.indices;
    const edgeSet = new Set<string>();
    
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
    
    return new Uint16Array(lineIndices);
  }
  
  private uploadWireframe(): void {
    const wireIndices = this.generateWireframeIndices();
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.wireIndexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, wireIndices, this.gl.STATIC_DRAW);
    this.wireIndexCount = wireIndices.length;
  }
  
  private generateNormalLineVertices(length = 0.1): Float32Array {
    const positions = this.geometry.positions;
    const normals = this.geometry.normals;
    const vertexCount = positions.length / 3;
    const lineVertices = new Float32Array(vertexCount * 6);
    
    for (let i = 0; i < vertexCount; i++) {
      const px = positions[i * 3];
      const py = positions[i * 3 + 1];
      const pz = positions[i * 3 + 2];
      const nx = normals[i * 3];
      const ny = normals[i * 3 + 1];
      const nz = normals[i * 3 + 2];
      
      lineVertices[i * 6] = px;
      lineVertices[i * 6 + 1] = py;
      lineVertices[i * 6 + 2] = pz;
      lineVertices[i * 6 + 3] = px + nx * length;
      lineVertices[i * 6 + 4] = py + ny * length;
      lineVertices[i * 6 + 5] = pz + nz * length;
    }
    
    return lineVertices;
  }
  
  private uploadNormalLines(): void {
    const lineVertices = this.generateNormalLineVertices();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.normalLineBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, lineVertices, this.gl.STATIC_DRAW);
    this.normalLineCount = lineVertices.length / 3;
  }
  
  // ============ Public API (IPrimitiveRenderer) ============
  
  updateGeometry(newConfig: PrimitiveConfig): void {
    this.config = { ...this.config, ...newConfig };
    this.geometry = generatePrimitiveGeometry(this.primitiveType, this.config);
    this.uploadGeometry();
    this.uploadWireframe();
    this.uploadNormalLines();
    
    // Update gpuMeshes reference
    this.gpuMeshes[0].indexCount = this.indexCount;
    this.gpuMeshes[0].vertexCount = this.geometry.positions.length / 3;
  }
  
  updateGeometryData(geometry: GeometryData): void {
    this.geometry = geometry;
    this.uploadGeometry();
    this.uploadWireframe();
    this.uploadNormalLines();
    
    // Update gpuMeshes reference
    this.gpuMeshes[0].indexCount = this.indexCount;
    this.gpuMeshes[0].vertexCount = this.geometry.positions.length / 3;
  }
  
  getBounds(): AABB {
    return computeBounds(this.geometry.positions);
  }
  
  setMaterial(mat: Partial<PBRMaterial>): void {
    if (mat.albedo) this.material.albedo = [...mat.albedo];
    if (mat.metallic !== undefined) this.material.metallic = mat.metallic;
    if (mat.roughness !== undefined) this.material.roughness = mat.roughness;
  }
  
  getMaterial(): PBRMaterial {
    return { ...this.material };
  }
  
  renderNormals(vpMatrix: mat4, modelMatrix: mat4): void {
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.wireProgram);
    gl.uniformMatrix4fv(this.wireLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniform3fv(this.wireLocations.uColor, [0.2, 0.8, 1.0]);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalLineBuffer);
    gl.enableVertexAttribArray(this.wireLocations.aPosition);
    gl.vertexAttribPointer(this.wireLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.drawArrays(gl.LINES, 0, this.normalLineCount);
  }
  
  render(
    vpMatrix: mat4,
    modelMatrix: mat4,
    isSelected: boolean,
    wireframeMode = false,
    lightParams: SceneLightingParams | null = null
  ): void {
    if (wireframeMode) {
      this.renderWireframe(vpMatrix, modelMatrix, isSelected);
      return;
    }
    
    if (isSelected) {
      this.renderOutline(vpMatrix, modelMatrix);
    }
    
    this.renderMain(vpMatrix, modelMatrix, isSelected, lightParams);
  }
  
  private renderOutline(vpMatrix: mat4, modelMatrix: mat4): void {
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.outlineProgram);
    gl.uniformMatrix4fv(this.outlineLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniformMatrix4fv(this.outlineLocations.uModel, false, modelMatrix);
    gl.uniform1f(this.outlineLocations.uOutlineWidth, 0.01);
    gl.uniform3fv(this.outlineLocations.uOutlineColor, [1.0, 0.4, 0.2]);
    
    if (this.isSingleSided) {
      gl.disable(gl.CULL_FACE);
    } else {
      gl.cullFace(gl.FRONT);
    }
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.outlineLocations.aPosition);
    gl.vertexAttribPointer(this.outlineLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(this.outlineLocations.aNormal);
    gl.vertexAttribPointer(this.outlineLocations.aNormal, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    
    if (this.isSingleSided) {
      gl.enable(gl.CULL_FACE);
    }
    gl.cullFace(gl.BACK);
  }
  
  private renderWireframe(vpMatrix: mat4, modelMatrix: mat4, isSelected: boolean): void {
    const gl = this.gl;
    mat4.multiply(this.mvpMatrix, vpMatrix, modelMatrix);
    
    gl.useProgram(this.wireProgram);
    gl.uniformMatrix4fv(this.wireLocations.uModelViewProjection, false, this.mvpMatrix);
    gl.uniform3fv(this.wireLocations.uColor, isSelected ? [1.0, 0.5, 0.3] : [0.7, 0.7, 0.7]);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(this.wireLocations.aPosition);
    gl.vertexAttribPointer(this.wireLocations.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.wireIndexBuffer);
    gl.drawElements(gl.LINES, this.wireIndexCount, gl.UNSIGNED_SHORT, 0);
  }
  
  private renderMain(
    vpMatrix: mat4, 
    modelMatrix: mat4, 
    isSelected: boolean,
    lightParams: SceneLightingParams | null
  ): void {
    const gl = this.gl;
    const loc = this.locations;
    
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
    
    // PBR material uniforms
    gl.uniform3fv(loc.uAlbedo, this.material.albedo);
    gl.uniform1f(loc.uMetallic, this.material.metallic);
    gl.uniform1f(loc.uRoughness, Math.max(0.04, this.material.roughness));
    gl.uniform3fv(loc.uCameraPos, (light as any)?.cameraPos || [0, 0, 5]);
    
    // Lighting uniforms
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
    const hdrMaxMipLevel = light?.type === 'hdr' ? (light as any).maxMipLevel : 6.0;
    gl.uniform1i(loc.uHasHdr, hdrTexture ? 1 : 0);
    gl.uniform1f(loc.uHdrExposure, hdrExposure);
    gl.uniform1f(loc.uHdrMaxMipLevel, hdrMaxMipLevel);
    
    gl.uniform1i(loc.uShadowEnabled, light?.shadowEnabled ? 1 : 0);
    gl.uniform1i(loc.uToneMapping, light?.toneMapping !== undefined ? light.toneMapping : 3);
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
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.enableVertexAttribArray(loc.aPosition);
    gl.vertexAttribPointer(loc.aPosition, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.enableVertexAttribArray(loc.aTexCoord);
    gl.vertexAttribPointer(loc.aTexCoord, 2, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.normalBuffer);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
    
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
  }
  
  destroy(): void {
    this._isDestroyed = true;
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
    gl.deleteBuffer(this.posBuffer);
    gl.deleteBuffer(this.uvBuffer);
    gl.deleteBuffer(this.normalBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.wireIndexBuffer);
    gl.deleteBuffer(this.normalLineBuffer);
    
    // Clear gpuMeshes to prevent stale references
    this.gpuMeshes.length = 0;
  }
}

/**
 * Factory function for backward compatibility
 * @deprecated Use `new PrimitiveRenderer(gl, primitiveType, config)` instead
 */
export function createPrimitiveRenderer(
  gl: WebGL2RenderingContext, 
  primitiveType: PrimitiveType, 
  config: PrimitiveConfig = {}
): PrimitiveRenderer {
  return new PrimitiveRenderer(gl, primitiveType, config);
}

/**
 * Factory function to create renderer from raw geometry data
 * Used by new primitive subclasses that generate their own geometry
 */
export function createPrimitiveRendererFromGeometry(
  gl: WebGL2RenderingContext,
  geometry: GeometryData
): PrimitiveRenderer {
  // Create a cube renderer as base, then replace geometry
  const renderer = new PrimitiveRenderer(gl, 'cube', {});
  renderer.updateGeometryData(geometry);
  return renderer;
}
