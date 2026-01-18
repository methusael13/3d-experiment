import { mat4, vec4 } from 'gl-matrix';

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `rgb(${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)})` : hex;
}

/**
 * Creates a pure Canvas 2D wireframe renderer
 * Only responsible for rendering - no animation loop or controls
 * 
 * @param {HTMLCanvasElement} canvas 
 * @param {object} model - { vertices: [{x,y,z}...], edges: [[i,j]...] }
 * @param {object} options - Optional configuration
 * @returns {object} { render(viewProjectionMatrix, modelMatrix), destroy() }
 */
export function createCanvasRenderer(canvas, model, options = {}) {
  const ctx = canvas.getContext('2d');
  
  const {
    foreground = '#ff0000',
    background = '#0d0d0d',
  } = options;
  
  // Temporary vec4 for transformations
  const tempVec = vec4.create();
  
  // Pre-compute vertex array for efficiency
  const vertices = model.vertices.map(v => [v.x, v.y, v.z, 1]);
  
  return {
    /**
     * Render a single frame
     * @param {mat4} viewProjectionMatrix - Combined view-projection matrix
     * @param {mat4} modelMatrix - Model transformation matrix
     */
    render(viewProjectionMatrix, modelMatrix) {
      const width = canvas.width;
      const height = canvas.height;
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      
      // Combined MVP matrix
      const mvpMatrix = mat4.create();
      mat4.multiply(mvpMatrix, viewProjectionMatrix, modelMatrix);
      
      // Clear canvas
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      
      // Transform all vertices to screen space
      const screenVertices = vertices.map(vertex => {
        vec4.set(tempVec, vertex[0], vertex[1], vertex[2], 1);
        vec4.transformMat4(tempVec, tempVec, mvpMatrix);
        
        // Perspective divide
        if (tempVec[3] <= 0) return null;
        
        const x = tempVec[0] / tempVec[3];
        const y = tempVec[1] / tempVec[3];
        
        // Convert from NDC (-1 to 1) to screen coordinates
        return {
          x: (x + 1) * halfWidth,
          y: (1 - y) * halfHeight, // Flip Y
        };
      });
      
      // Draw edges
      ctx.strokeStyle = foreground;
      ctx.lineWidth = 1;
      ctx.beginPath();
      
      for (const [i, j] of model.edges) {
        const from = screenVertices[i];
        const to = screenVertices[j];
        
        if (from && to) {
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
        }
      }
      
      ctx.stroke();
    },
    
    /**
     * Clean up resources (none for canvas)
     */
    destroy() {
      // Nothing to clean up for canvas
    },
  };
}
