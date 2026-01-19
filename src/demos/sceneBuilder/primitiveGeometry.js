/**
 * Primitive geometry generators
 * Generate vertex data (positions, normals, uvs, indices) for basic shapes
 */

/**
 * Generate cube geometry
 * @param {number} size - Size in grid units (cube extends from -size/2 to +size/2)
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array }}
 */
export function generateCube(size = 1) {
  const h = size / 2;
  
  // 6 faces, 4 vertices each = 24 vertices
  // Each face has its own vertices for correct normals
  const positions = new Float32Array([
    // Front face (Z+)
    -h, -h,  h,   h, -h,  h,   h,  h,  h,  -h,  h,  h,
    // Back face (Z-)
     h, -h, -h,  -h, -h, -h,  -h,  h, -h,   h,  h, -h,
    // Top face (Y+)
    -h,  h,  h,   h,  h,  h,   h,  h, -h,  -h,  h, -h,
    // Bottom face (Y-)
    -h, -h, -h,   h, -h, -h,   h, -h,  h,  -h, -h,  h,
    // Right face (X+)
     h, -h,  h,   h, -h, -h,   h,  h, -h,   h,  h,  h,
    // Left face (X-)
    -h, -h, -h,  -h, -h,  h,  -h,  h,  h,  -h,  h, -h,
  ]);
  
  const normals = new Float32Array([
    // Front
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    // Back
    0, 0, -1,  0, 0, -1,  0, 0, -1,  0, 0, -1,
    // Top
    0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    // Bottom
    0, -1, 0,  0, -1, 0,  0, -1, 0,  0, -1, 0,
    // Right
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
    // Left
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
  ]);
  
  const uvs = new Float32Array([
    // Front
    0, 0,  1, 0,  1, 1,  0, 1,
    // Back
    0, 0,  1, 0,  1, 1,  0, 1,
    // Top
    0, 0,  1, 0,  1, 1,  0, 1,
    // Bottom
    0, 0,  1, 0,  1, 1,  0, 1,
    // Right
    0, 0,  1, 0,  1, 1,  0, 1,
    // Left
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  
  const indices = new Uint16Array([
    // Front
    0, 1, 2,  0, 2, 3,
    // Back
    4, 5, 6,  4, 6, 7,
    // Top
    8, 9, 10,  8, 10, 11,
    // Bottom
    12, 13, 14,  12, 14, 15,
    // Right
    16, 17, 18,  16, 18, 19,
    // Left
    20, 21, 22,  20, 22, 23,
  ]);
  
  return { positions, normals, uvs, indices };
}

/**
 * Generate plane geometry on XZ plane with Y-up normal
 * @param {number} size - Size in grid units (plane extends from -size/2 to +size/2)
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array }}
 */
export function generatePlane(size = 1) {
  const h = size / 2;
  
  // 4 vertices for a simple quad
  const positions = new Float32Array([
    -h, 0,  h,   // bottom-left (in world: -X, +Z)
     h, 0,  h,   // bottom-right (+X, +Z)
     h, 0, -h,   // top-right (+X, -Z)
    -h, 0, -h,   // top-left (-X, -Z)
  ]);
  
  const normals = new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ]);
  
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  
  const indices = new Uint16Array([
    0, 1, 2,
    0, 2, 3,
  ]);
  
  return { positions, normals, uvs, indices };
}

/**
 * Generate UV sphere geometry
 * @param {number} radius - Sphere radius
 * @param {number} subdivisions - Number of horizontal segments (longitude lines)
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array }}
 */
export function generateSphere(radius = 0.5, subdivisions = 16) {
  const latBands = Math.max(4, Math.floor(subdivisions / 2));
  const longBands = subdivisions;
  
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  
  // Generate vertices
  for (let lat = 0; lat <= latBands; lat++) {
    const theta = (lat * Math.PI) / latBands;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    
    for (let lon = 0; lon <= longBands; lon++) {
      const phi = (lon * 2 * Math.PI) / longBands;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      
      // Normal is just the unit sphere position
      const nx = cosPhi * sinTheta;
      const ny = cosTheta;
      const nz = sinPhi * sinTheta;
      
      // Position = normal * radius
      const x = nx * radius;
      const y = ny * radius;
      const z = nz * radius;
      
      // UV coordinates
      const u = lon / longBands;
      const v = lat / latBands;
      
      positions.push(x, y, z);
      normals.push(nx, ny, nz);
      uvs.push(u, v);
    }
  }
  
  // Generate indices with correct CCW winding for outward-facing triangles
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;
      
      // Two triangles per quad - CCW winding when viewed from outside
      indices.push(first, first + 1, second);
      indices.push(first + 1, second + 1, second);
    }
  }
  
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * Compute axis-aligned bounding box for geometry
 * @param {Float32Array} positions - Vertex positions (x,y,z interleaved)
 * @returns {{ min: [number, number, number], max: [number, number, number] }}
 */
export function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  
  return { min, max };
}

/**
 * Generate geometry based on primitive type
 * @param {string} primitiveType - 'cube' | 'plane' | 'sphere'
 * @param {object} config - { size, subdivision }
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint16Array }}
 */
export function generatePrimitiveGeometry(primitiveType, config = {}) {
  const { size = 1, subdivision = 16 } = config;
  
  switch (primitiveType) {
    case 'cube':
      return generateCube(size);
    case 'plane':
      return generatePlane(size);
    case 'sphere':
      return generateSphere(size / 2, subdivision); // size is diameter, pass radius
    default:
      throw new Error(`Unknown primitive type: ${primitiveType}`);
  }
}
