/**
 * Orbit controller - animates camera position in an orbit around target
 */
export function createOrbitController(camera, options = {}) {
  const {
    radius = 3,
    height = 1,
    period = 5000, // milliseconds for full orbit
  } = options;
  
  let angle = 0;
  let speedMultiplier = 1;
  
  return {
    /**
     * Update the camera position based on elapsed time
     * @param {number} deltaTime - milliseconds since last frame
     */
    update(deltaTime) {
      const angularVelocity = (Math.PI * 2) / period;
      angle += angularVelocity * deltaTime * speedMultiplier;
      
      const x = Math.sin(angle) * radius;
      const y = height;
      const z = Math.cos(angle) * radius;
      
      camera.setPosition(x, y, z);
    },
    
    /**
     * Set the orbit speed multiplier
     * @param {number} multiplier 
     */
    setSpeed(multiplier) {
      speedMultiplier = multiplier;
    },
    
    /**
     * Get current speed multiplier
     * @returns {number}
     */
    getSpeed() {
      return speedMultiplier;
    },
    
    /**
     * Reset to initial state
     */
    reset() {
      angle = 0;
      speedMultiplier = 1;
    },
    
    /**
     * Get current angle
     * @returns {number}
     */
    getAngle() {
      return angle;
    },
  };
}
