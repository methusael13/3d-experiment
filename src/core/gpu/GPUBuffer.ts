/**
 * GPUBuffer - Unified buffer abstraction for WebGPU
 * Handles vertex, index, uniform, and storage buffers with automatic alignment
 */

import { GPUContext } from './GPUContext';

/** Buffer usage types */
export type GPUBufferType = 'vertex' | 'index' | 'uniform' | 'storage' | 'staging';

/** Options for buffer creation */
export interface GPUBufferOptions {
  /** Buffer label for debugging */
  label?: string;
  /** Initial data to upload */
  data?: ArrayBuffer | ArrayBufferView;
  /** Buffer size in bytes (required if no data provided) */
  size?: number;
  /** Whether the buffer can be copied from (for readback) */
  readback?: boolean;
  /** Whether the buffer can be copied to (for updates) */
  writable?: boolean;
}

/**
 * Calculates aligned size for uniform buffers (must be 256-byte aligned)
 */
export function alignTo256(size: number): number {
  return Math.ceil(size / 256) * 256;
}

/**
 * Calculates aligned size for storage buffers (must be 4-byte aligned)
 */
export function alignTo4(size: number): number {
  return Math.ceil(size / 4) * 4;
}

/**
 * Unified GPU buffer class
 */
export class UnifiedGPUBuffer {
  private _buffer: GPUBuffer;
  private _size: number;
  private _type: GPUBufferType;
  private _usage: GPUBufferUsageFlags;
  private _label: string;

  private constructor(
    buffer: GPUBuffer,
    size: number,
    type: GPUBufferType,
    usage: GPUBufferUsageFlags,
    label: string
  ) {
    this._buffer = buffer;
    this._size = size;
    this._type = type;
    this._usage = usage;
    this._label = label;
  }

  /**
   * Create a vertex buffer
   */
  static createVertex(ctx: GPUContext, options: GPUBufferOptions): UnifiedGPUBuffer {
    const { size, data, label = 'vertex-buffer', readback = false, writable = true } = options;
    
    let usage = GPUBufferUsage.VERTEX;
    if (writable) usage |= GPUBufferUsage.COPY_DST;
    if (readback) usage |= GPUBufferUsage.COPY_SRC;
    
    const bufferSize = data ? data.byteLength : size!;
    if (!bufferSize) throw new Error('Either data or size must be provided');

    const buffer = ctx.device.createBuffer({
      size: bufferSize,
      usage,
      label,
      mappedAtCreation: !!data,
    });

    if (data) {
      const mapped = new Uint8Array(buffer.getMappedRange());
      if (data instanceof ArrayBuffer) {
        mapped.set(new Uint8Array(data));
      } else {
        mapped.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      buffer.unmap();
    }

    return new UnifiedGPUBuffer(buffer, bufferSize, 'vertex', usage, label);
  }

  /**
   * Create an index buffer
   */
  static createIndex(ctx: GPUContext, options: GPUBufferOptions): UnifiedGPUBuffer {
    const { size, data, label = 'index-buffer', readback = false, writable = true } = options;
    
    let usage = GPUBufferUsage.INDEX;
    if (writable) usage |= GPUBufferUsage.COPY_DST;
    if (readback) usage |= GPUBufferUsage.COPY_SRC;
    
    const dataSize = data ? data.byteLength : size!;
    if (!dataSize) throw new Error('Either data or size must be provided');
    
    // When mappedAtCreation is true, buffer size must be multiple of 4
    const bufferSize = alignTo4(dataSize);

    const buffer = ctx.device.createBuffer({
      size: bufferSize,
      usage,
      label,
      mappedAtCreation: !!data,
    });

    if (data) {
      const mapped = new Uint8Array(buffer.getMappedRange());
      if (data instanceof ArrayBuffer) {
        mapped.set(new Uint8Array(data));
      } else {
        mapped.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      buffer.unmap();
    }

    return new UnifiedGPUBuffer(buffer, bufferSize, 'index', usage, label);
  }

  /**
   * Create a uniform buffer (automatically aligned to 256 bytes)
   */
  static createUniform(ctx: GPUContext, options: GPUBufferOptions): UnifiedGPUBuffer {
    const { size, data, label = 'uniform-buffer', readback = false, writable = true } = options;
    
    let usage = GPUBufferUsage.UNIFORM;
    if (writable) usage |= GPUBufferUsage.COPY_DST;
    if (readback) usage |= GPUBufferUsage.COPY_SRC;
    
    const dataSize = data ? data.byteLength : size!;
    if (!dataSize) throw new Error('Either data or size must be provided');
    
    // Uniform buffers must be 256-byte aligned
    const bufferSize = alignTo256(dataSize);

    const buffer = ctx.device.createBuffer({
      size: bufferSize,
      usage,
      label,
      mappedAtCreation: !!data,
    });

    if (data) {
      const mapped = new Uint8Array(buffer.getMappedRange());
      if (data instanceof ArrayBuffer) {
        mapped.set(new Uint8Array(data));
      } else {
        mapped.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      buffer.unmap();
    }

    return new UnifiedGPUBuffer(buffer, bufferSize, 'uniform', usage, label);
  }

  /**
   * Create a storage buffer
   */
  static createStorage(ctx: GPUContext, options: GPUBufferOptions): UnifiedGPUBuffer {
    const { size, data, label = 'storage-buffer', readback = false, writable = true } = options;
    
    let usage = GPUBufferUsage.STORAGE;
    if (writable) usage |= GPUBufferUsage.COPY_DST;
    if (readback) usage |= GPUBufferUsage.COPY_SRC;
    
    const dataSize = data ? data.byteLength : size!;
    if (!dataSize) throw new Error('Either data or size must be provided');
    
    // Storage buffers should be 4-byte aligned
    const bufferSize = alignTo4(dataSize);

    const buffer = ctx.device.createBuffer({
      size: bufferSize,
      usage,
      label,
      mappedAtCreation: !!data,
    });

    if (data) {
      const mapped = new Uint8Array(buffer.getMappedRange());
      if (data instanceof ArrayBuffer) {
        mapped.set(new Uint8Array(data));
      } else {
        mapped.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }
      buffer.unmap();
    }

    return new UnifiedGPUBuffer(buffer, bufferSize, 'storage', usage, label);
  }

  /**
   * Create a staging buffer for CPU readback
   */
  static createStaging(ctx: GPUContext, size: number, label = 'staging-buffer'): UnifiedGPUBuffer {
    const buffer = ctx.device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label,
    });

    return new UnifiedGPUBuffer(buffer, size, 'staging', GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label);
  }

  /**
   * Write data to the buffer
   */
  write(ctx: GPUContext, data: ArrayBuffer | ArrayBufferView, offset = 0): void {
    if (!(this._usage & GPUBufferUsage.COPY_DST)) {
      throw new Error('Buffer is not writable (missing COPY_DST usage)');
    }

    if (data instanceof ArrayBuffer) {
      ctx.queue.writeBuffer(this._buffer, offset, data);
    } else {
      ctx.queue.writeBuffer(this._buffer, offset, data.buffer, data.byteOffset, data.byteLength);
    }
  }

  /**
   * Read data from the buffer (async, requires staging buffer copy)
   */
  async read(ctx: GPUContext): Promise<ArrayBuffer> {
    if (this._type === 'staging') {
      // Direct read from staging buffer
      await this._buffer.mapAsync(GPUMapMode.READ);
      const data = this._buffer.getMappedRange().slice(0);
      this._buffer.unmap();
      return data;
    }

    // Copy to staging buffer first
    const staging = UnifiedGPUBuffer.createStaging(ctx, this._size, `${this._label}-staging`);
    
    const encoder = ctx.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this._buffer, 0, staging.buffer, 0, this._size);
    ctx.queue.submit([encoder.finish()]);

    const data = await staging.read(ctx);
    staging.destroy();
    return data;
  }

  // Getters
  get buffer(): GPUBuffer {
    return this._buffer;
  }

  get size(): number {
    return this._size;
  }

  get type(): GPUBufferType {
    return this._type;
  }

  get label(): string {
    return this._label;
  }

  /**
   * Destroy the buffer and release GPU memory
   */
  destroy(): void {
    this._buffer.destroy();
  }
}

/**
 * Helper class for building structured uniform data
 */
export class UniformBuilder {
  private data: Float32Array;
  private offset: number = 0;

  constructor(floatCount: number) {
    this.data = new Float32Array(floatCount);
  }

  /**
   * Add a float value
   */
  float(value: number): this {
    this.data[this.offset++] = value;
    return this;
  }

  /**
   * Add a vec2 (2 floats)
   */
  vec2(x: number, y: number): this {
    this.data[this.offset++] = x;
    this.data[this.offset++] = y;
    return this;
  }

  /**
   * Add a vec3 (3 floats, padded to 4 for alignment)
   */
  vec3(x: number, y: number, z: number): this {
    this.data[this.offset++] = x;
    this.data[this.offset++] = y;
    this.data[this.offset++] = z;
    this.data[this.offset++] = 0; // padding
    return this;
  }

  /**
   * Add a vec4 (4 floats)
   */
  vec4(x: number, y: number, z: number, w: number): this {
    this.data[this.offset++] = x;
    this.data[this.offset++] = y;
    this.data[this.offset++] = z;
    this.data[this.offset++] = w;
    return this;
  }

  /**
   * Add a mat4 (16 floats)
   */
  mat4(matrix: Float32Array | number[]): this {
    for (let i = 0; i < 16; i++) {
      this.data[this.offset++] = matrix[i];
    }
    return this;
  }

  /**
   * Add padding to align to vec4 boundary
   */
  alignVec4(): this {
    const remainder = this.offset % 4;
    if (remainder !== 0) {
      this.offset += 4 - remainder;
    }
    return this;
  }

  /**
   * Get the built data
   */
  build(): Float32Array {
    return this.data;
  }

  /**
   * Reset the builder for reuse
   */
  reset(): this {
    this.offset = 0;
    return this;
  }
}
