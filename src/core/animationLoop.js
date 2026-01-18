/**
 * Animation loop manager - handles requestAnimationFrame, delta time, and FPS tracking
 */
export function createAnimationLoop(options = {}) {
  const { onFps = null } = options;
  
  let animationId = null;
  let lastTime = null;
  let frameCallback = null;
  
  // FPS tracking
  let frameCount = 0;
  let fpsLastTime = 0;
  
  function tick(time) {
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
    
    // Call the frame callback
    if (frameCallback) {
      frameCallback(deltaTime, time);
    }
    
    animationId = requestAnimationFrame(tick);
  }
  
  return {
    /**
     * Start the animation loop
     * @param {Function} callback - Called each frame with (deltaTime, totalTime)
     */
    start(callback) {
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
    stop() {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
        frameCallback = null;
      }
    },
    
    /**
     * Check if loop is running
     */
    isRunning() {
      return animationId !== null;
    },
  };
}
