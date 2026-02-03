/**
 * PreactSceneBuilderDemo - Adapter that wraps the Preact SceneBuilderApp
 * with the demo interface expected by main.js
 */

import { mountSceneBuilderApp, type SceneBuilderAppProps } from './components/app/SceneBuilderApp';

// ==================== Types ====================

export interface SceneBuilderDemoOptions {
  width?: number;
  height?: number;
  onFps?: (fps: number) => void;
}

export interface SceneBuilderDemo {
  init(): Promise<void>;
  destroy(): void;
  name: string;
  description: string;
}

// ==================== PreactSceneBuilderDemo ====================

export class PreactSceneBuilderDemo implements SceneBuilderDemo {
  readonly name = 'Scene Builder (Preact)';
  readonly description = 'Import and position 3D models - Preact UI';
  
  private container: HTMLElement;
  private options: SceneBuilderDemoOptions;
  private unmount: (() => void) | null = null;
  
  constructor(container: HTMLElement, options: SceneBuilderDemoOptions = {}) {
    this.container = container;
    this.options = options;
  }
  
  async init(): Promise<void> {
    // Mount the Preact app
    this.unmount = mountSceneBuilderApp(this.container, {
      width: this.options.width,
      height: this.options.height,
      onFps: this.options.onFps,
    });
    
    console.log('[PreactSceneBuilderDemo] Initialized');
  }
  
  destroy(): void {
    if (this.unmount) {
      this.unmount();
      this.unmount = null;
    }
    
    // Clear container
    this.container.innerHTML = '';
    
    console.log('[PreactSceneBuilderDemo] Destroyed');
  }
}

// ==================== Factory Function ====================

/**
 * Creates a Preact Scene Builder demo instance
 */
export function createPreactSceneBuilderDemo(
  container: HTMLElement,
  options?: SceneBuilderDemoOptions
): SceneBuilderDemo {
  return new PreactSceneBuilderDemo(container, options);
}
