/**
 * CubemapMipGenerator — Generates roughness mip levels for a probe cubemap
 * using GGX importance sampling (same technique as IBL specular pre-filter).
 *
 * For each mip level 1..N:
 *   - Computes roughness = mipLevel / maxMipLevel
 *   - For each of the 6 faces:
 *     - Samples the base cubemap (mip 0) as a cube texture with GGX distribution
 *     - Alpha-weights samples to handle sky holes (rgba 0,0,0,0)
 *     - Writes the pre-filtered result to the current mip level
 *
 * The cubemap texture must be created with:
 *   - `mipLevelCount > 1`
 *   - `GPUTextureUsage.STORAGE_BINDING` (for compute writes)
 *   - `GPUTextureUsage.TEXTURE_BINDING` (for cube sampling)
 *   - format: 'rgba16float'
 */

import prefilterShaderSource from '../shaders/cubemap-specular-prefilter.wgsl?raw';

export class CubemapMipGenerator {
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;

  constructor(device: GPUDevice) {
    this.device = device;
  }

  /**
   * Lazily initialize the compute pipeline and resources.
   */
  private ensureInitialized(): void {
    if (this.pipeline) return;

    const device = this.device;

    // Bind group layout:
    //   0: uniform (roughness, faceIndex)
    //   1: source cubemap (cube texture for sampling)
    //   2: sampler (linear filtering for textureSampleLevel)
    //   3: destination face (2D storage texture for write)
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'cubemap-prefilter-layout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          texture: { sampleType: 'float', viewDimension: 'cube' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          sampler: { type: 'filtering' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
        },
      ],
    });

    const shaderModule = device.createShaderModule({
      label: 'cubemap-prefilter-shader',
      code: prefilterShaderSource,
    });

    this.pipeline = device.createComputePipeline({
      label: 'cubemap-prefilter-pipeline',
      layout: device.createPipelineLayout({
        label: 'cubemap-prefilter-pipeline-layout',
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    this.sampler = device.createSampler({
      label: 'cubemap-prefilter-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    });
  }

  /**
   * Generate all mip levels for a cubemap texture using GGX pre-filtering.
   *
   * Mip 0 is the base (sharp reflections, already rendered).
   * Mip N = roughness N/maxMip, pre-filtered with GGX importance sampling.
   *
   * @param cubemapTexture - The cubemap texture (6 array layers, multiple mip levels)
   * @param queue - The GPU queue to submit commands on
   */
  generateMips(cubemapTexture: GPUTexture, queue: GPUQueue): void {
    this.ensureInitialized();

    const mipLevelCount = cubemapTexture.mipLevelCount;
    if (mipLevelCount <= 1) return;

    const device = this.device;
    const maxMip = mipLevelCount - 1;

    // Source: cube view of the full cubemap (mip 0 only for sampling)
    const srcCubeView = cubemapTexture.createView({
      label: 'cubemap-prefilter-src-cube',
      dimension: 'cube',
      arrayLayerCount: 6,
      baseMipLevel: 0,
      mipLevelCount: 1,
    });

    // Create per-mip uniform buffers (roughness + faceIndex per dispatch)
    // We need one per (mip, face) combination since all dispatches go in one encoder
    const uniformBuffers: GPUBuffer[] = [];

    const encoder = device.createCommandEncoder({
      label: 'cubemap-prefilter-generate',
    });

    for (let mip = 1; mip < mipLevelCount; mip++) {
      const roughness = mip / maxMip;
      const mipWidth = Math.max(1, cubemapTexture.width >> mip);
      const mipHeight = Math.max(1, cubemapTexture.height >> mip);

      for (let face = 0; face < 6; face++) {
        // Uniform buffer: roughness (f32) + faceIndex (u32) + pad (2 x u32) = 16 bytes
        const uniformBuffer = device.createBuffer({
          label: `cubemap-prefilter-uniforms-mip${mip}-face${face}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const uniformData = new ArrayBuffer(16);
        const f32View = new Float32Array(uniformData);
        const u32View = new Uint32Array(uniformData);
        f32View[0] = roughness;
        u32View[1] = face;
        u32View[2] = 0; // pad
        u32View[3] = 0; // pad
        queue.writeBuffer(uniformBuffer, 0, uniformData);
        uniformBuffers.push(uniformBuffer);

        // Destination: 2D storage view of this face at this mip level
        const dstView = cubemapTexture.createView({
          label: `cubemap-prefilter-dst-face${face}-mip${mip}`,
          dimension: '2d',
          baseArrayLayer: face,
          arrayLayerCount: 1,
          baseMipLevel: mip,
          mipLevelCount: 1,
        });

        const bindGroup = device.createBindGroup({
          label: `cubemap-prefilter-bg-face${face}-mip${mip}`,
          layout: this.bindGroupLayout!,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: srcCubeView },
            { binding: 2, resource: this.sampler! },
            { binding: 3, resource: dstView },
          ],
        });

        const pass = encoder.beginComputePass({
          label: `cubemap-prefilter-pass-face${face}-mip${mip}`,
        });

        pass.setPipeline(this.pipeline!);
        pass.setBindGroup(0, bindGroup);

        const workgroupsX = Math.ceil(mipWidth / 8);
        const workgroupsY = Math.ceil(mipHeight / 8);
        pass.dispatchWorkgroups(workgroupsX, workgroupsY);

        pass.end();
      }
    }

    // Single submission — each mip reads from mip 0 (base), not from previous mip,
    // so there are no data dependencies between mip levels.
    queue.submit([encoder.finish()]);

    // Clean up per-dispatch uniform buffers
    for (const buf of uniformBuffers) {
      buf.destroy();
    }
  }

  /**
   * Calculate the number of mip levels for a given resolution.
   */
  static mipLevelCount(resolution: number): number {
    return Math.floor(Math.log2(resolution)) + 1;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
    this.sampler = null;
  }
}