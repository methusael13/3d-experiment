/**
 * Abstract base class for all model loaders
 */

import type { LoaderOptions } from './types';

/**
 * Abstract base loader that provides common utilities for all loaders
 * @template T The type of model data returned by the loader
 */
export abstract class BaseLoader<T> {
  protected url: string;
  protected options: LoaderOptions;
  
  constructor(url: string, options: LoaderOptions = {}) {
    this.url = url;
    this.options = {
      normalize: true,
      ...options,
    };
  }
  
  /**
   * Load and parse the model file
   */
  abstract load(): Promise<T>;
  
  /**
   * Get the file extensions this loader supports
   */
  abstract getSupportedExtensions(): string[];
  
  /**
   * Check if this loader supports the given file extension
   */
  supportsExtension(extension: string): boolean {
    const ext = extension.toLowerCase().startsWith('.') 
      ? extension.toLowerCase() 
      : `.${extension.toLowerCase()}`;
    return this.getSupportedExtensions().includes(ext);
  }
  
  /**
   * Get the file extension from the URL
   */
  protected getExtension(): string {
    const url = this.url.split('?')[0]; // Remove query params
    const lastDot = url.lastIndexOf('.');
    return lastDot !== -1 ? url.slice(lastDot).toLowerCase() : '';
  }
  
  /**
   * Fetch URL as ArrayBuffer (for binary formats like GLB)
   */
  protected async fetchArrayBuffer(): Promise<ArrayBuffer> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${this.url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  }
  
  /**
   * Fetch URL as text (for text formats like OBJ, glTF JSON)
   */
  protected async fetchText(): Promise<string> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${this.url}: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
  
  /**
   * Fetch URL as JSON
   */
  protected async fetchJSON<J = unknown>(): Promise<J> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${this.url}: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<J>;
  }
  
  /**
   * Fetch URL as Blob
   */
  protected async fetchBlob(): Promise<Blob> {
    const response = await fetch(this.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${this.url}: ${response.status} ${response.statusText}`);
    }
    return response.blob();
  }
}
