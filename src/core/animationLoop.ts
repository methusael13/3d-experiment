/**
 * Callback function called each frame
 * @param deltaTime - Time since last frame in milliseconds
 * @param totalTime - Total time since start in milliseconds
 */
export type FrameCallback = (deltaTime: number, totalTime: number) => void;

/**
 * Callback function called with FPS count
 * @param fps - Frames per second
 */
export type FpsCallback = (fps: number) => void;

/**
 * Options for creating an animation loop
 */
export interface AnimationLoopOptions {
  /** Callback called each second with the FPS count */
  onFps?: FpsCallback | null;
}

/**
 * Animation loop interface
 */
export interface AnimationLoop {
  /** Start the animation loop with a frame callback */
  start(callback: FrameCallback): void;
  /** Stop the animation loop */
  stop(): void;
  /** Check if the loop is currently running */
  isRunning(): boolean;
  /** Pause rendering (rAF still ticks but frame callback is skipped) */
  setPaused(paused: boolean): void;
  /** Check if the loop is paused */
  isPaused(): boolean;
}

/**
 * Animation loop manager - handles requestAnimationFrame, delta time, and FPS tracking
 */
export function createAnimationLoop(options: AnimationLoopOptions = {}): AnimationLoop {
  const { onFps = null } = options;
  
  let animationId: number | null = null;
  let lastTime: number | null = null;
  let frameCallback: FrameCallback | null = null;
  let paused = false;
  
  // FPS tracking
  let frameCount = 0;
  let fpsLastTime = 0;
  
  function tick(time: number): void {
    if (lastTime === null) {
      lastTime = time;
      fpsLastTime = time;
    }
    
    const deltaTime = time - lastTime;
    lastTime = time;
    
    // FPS calculation
    frameCount++;
    if (time - fpsLastTime >= 1000) {
      if (onFps) {
        onFps(frameCount);
      }
      frameCount = 0;
      fpsLastTime = time;
    }
    
    // Call the frame callback (skip if paused — saves GPU work)
    if (frameCallback && !paused) {
      frameCallback(deltaTime, time);
    }
    
    animationId = requestAnimationFrame(tick);
  }
  
  return {
    /**
     * Start the animation loop
     * @param callback - Called each frame with (deltaTime, totalTime)
     */
    start(callback: FrameCallback): void {
      frameCallback = callback;
      if (!animationId) {
        lastTime = null;
        frameCount = 0;
        animationId = requestAnimationFrame(tick);
      }
    },
    
    /**
     * Stop the animation loop
     */
    stop(): void {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
        frameCallback = null;
      }
    },
    
    /**
     * Check if loop is running
     */
    isRunning(): boolean {
      return animationId !== null;
    },
    
    /**
     * Pause/resume rendering. When paused, rAF keeps ticking (to maintain FPS tracking)
     * but the frame callback is skipped (no GPU commands submitted).
     */
    setPaused(value: boolean): void {
      paused = value;
    },
    
    /**
     * Check if rendering is paused
     */
    isPaused(): boolean {
      return paused;
    },
  };
}
