import { describe, it, expect } from 'vitest';
import { quat, mat4, vec3 } from 'gl-matrix';
import { createViewMatrix, getTargetFromDirection, worldToCamera, perspectiveProject, cameraToScreen, eulerToQuat, quatToEuler, eulerEquals } from './mathUtils';

describe('createViewMatrix', () => {
  it('creates identity-like matrix when camera at origin looking down -Z', () => {
    const viewMatrix = createViewMatrix(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 1, z: 0 }
    );
    // Point at origin should stay at origin
    const result = worldToCamera({ x: 0, y: 0, z: 0 }, viewMatrix);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });

  it('translates points when camera moves', () => {
    const viewMatrix = createViewMatrix(
      { x: 0, y: 0, z: 5 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    );
    // Point at origin should appear at z=-5 in camera space
    const result = worldToCamera({ x: 0, y: 0, z: 0 }, viewMatrix);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(-5);
  });
});

describe('getTargetFromDirection', () => {
  it('computes target point from position and direction', () => {
    const target = getTargetFromDirection(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 }
    );
    expect(target.x).toBeCloseTo(0);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(-1);
  });

  it('normalizes direction vector', () => {
    const target = getTargetFromDirection(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -10 }
    );
    expect(target.x).toBeCloseTo(0);
    expect(target.y).toBeCloseTo(0);
    expect(target.z).toBeCloseTo(-1);
  });

  it('adds normalized direction to position', () => {
    const target = getTargetFromDirection(
      { x: 5, y: 3, z: 2 },
      { x: 1, y: 0, z: 0 }
    );
    expect(target.x).toBeCloseTo(6);
    expect(target.y).toBeCloseTo(3);
    expect(target.z).toBeCloseTo(2);
  });
});

describe('worldToCamera', () => {
  it('transforms point using view matrix', () => {
    const viewMatrix = createViewMatrix(
      { x: 0, y: 0, z: 2 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    );
    const result = worldToCamera({ x: 0, y: 0, z: 0 }, viewMatrix);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(-2);
  });

  it('handles rotated camera', () => {
    // Camera at origin looking down +X axis
    const viewMatrix = createViewMatrix(
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    );
    // Point on +X axis should appear on -Z in camera space
    const result = worldToCamera({ x: 5, y: 0, z: 0 }, viewMatrix);
    expect(result.z).toBeCloseTo(-5);
  });
});

describe('perspectiveProject', () => {
  const near = 1;
  const fov = Math.PI / 2; // 90 degrees

  describe('basic projection', () => {
    it('projects point on -Z axis to origin', () => {
      const result = perspectiveProject({ x: 0, y: 0, z: -2 }, near, fov);
      expect(result!.x).toBe(0);
      expect(result!.y).toBe(0);
    });

    it('returns null for points behind camera (positive z)', () => {
      const result = perspectiveProject({ x: 1, y: 1, z: 1 }, near, fov);
      expect(result).toBeNull();
    });

    it('returns null for points at camera (z = 0)', () => {
      const result = perspectiveProject({ x: 1, y: 1, z: 0 }, near, fov);
      expect(result).toBeNull();
    });

    it('returns null for points at near plane', () => {
      const result = perspectiveProject({ x: 1, y: 1, z: -1 }, near, fov);
      expect(result).toBeNull();
    });
  });

  describe('perspective division', () => {
    it('closer objects appear larger', () => {
      const closePoint = perspectiveProject({ x: 1, y: 0, z: -2 }, near, fov);
      const farPoint = perspectiveProject({ x: 1, y: 0, z: -4 }, near, fov);
      expect(closePoint!.x).toBeGreaterThan(farPoint!.x);
    });

    it('scales x and y inversely with distance', () => {
      const result = perspectiveProject({ x: 1, y: 1, z: -2 }, near, fov);
      expect(result!.x).toBeCloseTo(0.5);
      expect(result!.y).toBeCloseTo(0.5);
    });
  });

  describe('FOV handling', () => {
    it('narrower FOV makes objects appear larger', () => {
      const wideFov = perspectiveProject({ x: 1, y: 0, z: -2 }, near, Math.PI / 2);
      const narrowFov = perspectiveProject({ x: 1, y: 0, z: -2 }, near, Math.PI / 4);
      expect(narrowFov!.x).toBeGreaterThan(wideFov!.x);
    });
  });
});

describe('cameraToScreen', () => {
  describe('square screen (800x800)', () => {
    const width = 800;
    const height = 800;

    it('transforms center (0, 0) to screen center', () => {
      const result = cameraToScreen({ x: 0, y: 0 }, width, height);
      expect(result.x).toBe(400);
      expect(result.y).toBe(400);
    });

    it('transforms top-left (-1, 1) to screen (0, 0)', () => {
      const result = cameraToScreen({ x: -1, y: 1 }, width, height);
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('transforms bottom-right (1, -1) to screen (width, height)', () => {
      const result = cameraToScreen({ x: 1, y: -1 }, width, height);
      expect(result.x).toBe(800);
      expect(result.y).toBe(800);
    });
  });

  describe('wide screen (800x600, aspectRatio ~1.33)', () => {
    const width = 800;
    const height = 600;

    it('transforms center (0, 0) to screen center', () => {
      const result = cameraToScreen({ x: 0, y: 0 }, width, height);
      expect(result.x).toBe(400);
      expect(result.y).toBe(300);
    });

    it('transforms top-left (-1, 1) to screen with x compressed', () => {
      const result = cameraToScreen({ x: -1, y: 1 }, width, height);
      expect(result.x).toBe(100);
      expect(result.y).toBe(0);
    });

    it('transforms bottom-right (1, -1) to screen with x compressed', () => {
      const result = cameraToScreen({ x: 1, y: -1 }, width, height);
      expect(result.x).toBe(700);
      expect(result.y).toBe(600);
    });

    it('maintains square proportions (unit square stays square)', () => {
      const topLeft = cameraToScreen({ x: -0.5, y: 0.5 }, width, height);
      const bottomRight = cameraToScreen({ x: 0.5, y: -0.5 }, width, height);
      
      const screenWidth = bottomRight.x - topLeft.x;
      const screenHeight = bottomRight.y - topLeft.y;
      
      expect(screenWidth).toBe(screenHeight);
    });
  });

  describe('tall screen (600x800, aspectRatio 0.75)', () => {
    const width = 600;
    const height = 800;

    it('transforms center (0, 0) to screen center', () => {
      const result = cameraToScreen({ x: 0, y: 0 }, width, height);
      expect(result.x).toBe(300);
      expect(result.y).toBe(400);
    });

    it('transforms top-left (-1, 1) to screen with y compressed', () => {
      const result = cameraToScreen({ x: -1, y: 1 }, width, height);
      expect(result.x).toBe(0);
      expect(result.y).toBe(100);
    });

    it('transforms bottom-right (1, -1) to screen with y compressed', () => {
      const result = cameraToScreen({ x: 1, y: -1 }, width, height);
      expect(result.x).toBe(600);
      expect(result.y).toBe(700);
    });

    it('maintains square proportions (unit square stays square)', () => {
      const topLeft = cameraToScreen({ x: -0.5, y: 0.5 }, width, height);
      const bottomRight = cameraToScreen({ x: 0.5, y: -0.5 }, width, height);
      
      const screenWidth = bottomRight.x - topLeft.x;
      const screenHeight = bottomRight.y - topLeft.y;
      
      expect(screenWidth).toBe(screenHeight);
    });
  });
});

// ==================== Euler ↔ Quaternion Conversion Tests ====================

describe('eulerToQuat', () => {
  describe('identity and single-axis rotations', () => {
    it('converts zero rotation to identity quaternion', () => {
      const q = eulerToQuat([0, 0, 0]);
      expect(q[0]).toBeCloseTo(0); // x
      expect(q[1]).toBeCloseTo(0); // y
      expect(q[2]).toBeCloseTo(0); // z
      expect(q[3]).toBeCloseTo(1); // w
    });

    it('converts 90° X rotation correctly', () => {
      const q = eulerToQuat([90, 0, 0]);
      // For 90° around X: q = (sin(45°), 0, 0, cos(45°))
      const s = Math.sin(Math.PI / 4);
      const c = Math.cos(Math.PI / 4);
      expect(q[0]).toBeCloseTo(s);
      expect(q[1]).toBeCloseTo(0);
      expect(q[2]).toBeCloseTo(0);
      expect(q[3]).toBeCloseTo(c);
    });

    it('converts 90° Y rotation correctly', () => {
      const q = eulerToQuat([0, 90, 0]);
      const s = Math.sin(Math.PI / 4);
      const c = Math.cos(Math.PI / 4);
      expect(q[0]).toBeCloseTo(0);
      expect(q[1]).toBeCloseTo(s);
      expect(q[2]).toBeCloseTo(0);
      expect(q[3]).toBeCloseTo(c);
    });

    it('converts 90° Z rotation correctly', () => {
      const q = eulerToQuat([0, 0, 90]);
      const s = Math.sin(Math.PI / 4);
      const c = Math.cos(Math.PI / 4);
      expect(q[0]).toBeCloseTo(0);
      expect(q[1]).toBeCloseTo(0);
      expect(q[2]).toBeCloseTo(s);
      expect(q[3]).toBeCloseTo(c);
    });

    it('converts 45° X rotation correctly', () => {
      const q = eulerToQuat([45, 0, 0]);
      const s = Math.sin(Math.PI / 8);
      const c = Math.cos(Math.PI / 8);
      expect(q[0]).toBeCloseTo(s);
      expect(q[1]).toBeCloseTo(0);
      expect(q[2]).toBeCloseTo(0);
      expect(q[3]).toBeCloseTo(c);
    });
  });

  describe('combined rotations', () => {
    it('converts combined X and Y rotation', () => {
      const q = eulerToQuat([25, 35, 0]);
      // Verify quaternion is normalized
      const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
      expect(len).toBeCloseTo(1);
    });

    it('produces unit quaternions', () => {
      const testCases: [number, number, number][] = [
        [30, 45, 60],
        [15, 0, 90],
        [0, 45, 30],
        [90, 90, 90],
      ];

      for (const euler of testCases) {
        const q = eulerToQuat(euler);
        const len = Math.sqrt(q[0]*q[0] + q[1]*q[1] + q[2]*q[2] + q[3]*q[3]);
        expect(len).toBeCloseTo(1, 5);
      }
    });
  });
});

describe('quatToEuler', () => {
  describe('identity and single-axis rotations', () => {
    it('converts identity quaternion to zero rotation', () => {
      const q = quat.create(); // identity
      const euler = quatToEuler(q);
      expect(euler[0]).toBeCloseTo(0);
      expect(euler[1]).toBeCloseTo(0);
      expect(euler[2]).toBeCloseTo(0);
    });

    it('converts X-only rotation back correctly', () => {
      const angle = Math.PI / 4; // 45 degrees
      const q = quat.create();
      quat.setAxisAngle(q, [1, 0, 0], angle);
      const euler = quatToEuler(q);
      expect(euler[0]).toBeCloseTo(45);
      expect(euler[1]).toBeCloseTo(0);
      expect(euler[2]).toBeCloseTo(0);
    });

    it('converts Y-only rotation back correctly', () => {
      const angle = Math.PI / 6; // 30 degrees
      const q = quat.create();
      quat.setAxisAngle(q, [0, 1, 0], angle);
      const euler = quatToEuler(q);
      expect(euler[0]).toBeCloseTo(0);
      expect(euler[1]).toBeCloseTo(30);
      expect(euler[2]).toBeCloseTo(0);
    });

    it('converts Z-only rotation back correctly', () => {
      const angle = Math.PI / 3; // 60 degrees
      const q = quat.create();
      quat.setAxisAngle(q, [0, 0, 1], angle);
      const euler = quatToEuler(q);
      expect(euler[0]).toBeCloseTo(0);
      expect(euler[1]).toBeCloseTo(0);
      expect(euler[2]).toBeCloseTo(60);
    });
  });
});

describe('eulerToQuat ↔ quatToEuler round-trip', () => {
  const testRoundTrip = (input: [number, number, number], tolerance = 0.001) => {
    const q = eulerToQuat(input);
    const output = quatToEuler(q);
    
    // For round-trip, we check if the rotations are equivalent
    // (there can be multiple Euler representations for the same rotation)
    const qBack = eulerToQuat([output[0], output[1], output[2]]);
    const dot = quat.dot(q, qBack);
    expect(Math.abs(Math.abs(dot) - 1)).toBeLessThan(tolerance);
  };

  describe('single-axis rotations', () => {
    it('round-trips [45, 0, 0]', () => {
      const euler = quatToEuler(eulerToQuat([45, 0, 0]));
      expect(euler[0]).toBeCloseTo(45, 1);
      expect(euler[1]).toBeCloseTo(0, 1);
      expect(euler[2]).toBeCloseTo(0, 1);
    });

    it('round-trips [0, 45, 0]', () => {
      const euler = quatToEuler(eulerToQuat([0, 45, 0]));
      expect(euler[0]).toBeCloseTo(0, 1);
      expect(euler[1]).toBeCloseTo(45, 1);
      expect(euler[2]).toBeCloseTo(0, 1);
    });

    it('round-trips [0, 0, 45]', () => {
      const euler = quatToEuler(eulerToQuat([0, 0, 45]));
      expect(euler[0]).toBeCloseTo(0, 1);
      expect(euler[1]).toBeCloseTo(0, 1);
      expect(euler[2]).toBeCloseTo(45, 1);
    });
  });

  describe('combined rotations (critical tests)', () => {
    it('round-trips [25, 35, 0] - the reported bug case', () => {
      const input: [number, number, number] = [25, 35, 0];
      const q = eulerToQuat(input);
      const output = quatToEuler(q);
      
      // Z should be close to 0
      expect(output[0]).toBeCloseTo(25, 0);
      expect(output[1]).toBeCloseTo(35, 0);
      expect(output[2]).toBeCloseTo(0, 0);
    });

    it('round-trips [30, 45, 0]', () => {
      const euler = quatToEuler(eulerToQuat([30, 45, 0]));
      expect(euler[0]).toBeCloseTo(30, 0);
      expect(euler[1]).toBeCloseTo(45, 0);
      expect(euler[2]).toBeCloseTo(0, 0);
    });

    it('round-trips [0, 30, 45]', () => {
      const euler = quatToEuler(eulerToQuat([0, 30, 45]));
      expect(euler[0]).toBeCloseTo(0, 0);
      expect(euler[1]).toBeCloseTo(30, 0);
      expect(euler[2]).toBeCloseTo(45, 0);
    });

    it('round-trips [45, 0, 30]', () => {
      const euler = quatToEuler(eulerToQuat([45, 0, 30]));
      expect(euler[0]).toBeCloseTo(45, 0);
      expect(euler[1]).toBeCloseTo(0, 0);
      expect(euler[2]).toBeCloseTo(30, 0);
    });

    it('round-trips [15, 25, 35]', () => {
      testRoundTrip([15, 25, 35]);
    });

    it('round-trips [60, 30, 15]', () => {
      testRoundTrip([60, 30, 15]);
    });
  });

  describe('edge cases', () => {
    it('round-trips near gimbal lock [0, 89, 0]', () => {
      testRoundTrip([0, 89, 0]);
    });

    it('round-trips near gimbal lock [0, -89, 0]', () => {
      testRoundTrip([0, -89, 0]);
    });

    it('round-trips negative angles', () => {
      testRoundTrip([-30, -45, -60]);
    });

    it('round-trips large angles', () => {
      testRoundTrip([120, 30, 60]);
    });
  });
});

describe('eulerEquals', () => {
  it('returns true for identical angles', () => {
    expect(eulerEquals([30, 45, 60], [30, 45, 60])).toBe(true);
  });

  it('returns true for equivalent rotations', () => {
    // After round-trip, should still be equivalent
    const original: [number, number, number] = [25, 35, 0];
    const q = eulerToQuat(original);
    const recovered = quatToEuler(q);
    expect(eulerEquals(original, [recovered[0], recovered[1], recovered[2]])).toBe(true);
  });

  it('returns false for different rotations', () => {
    expect(eulerEquals([30, 45, 60], [30, 45, 90])).toBe(false);
  });
});

describe('rotation matrix verification', () => {
  it('eulerToQuat produces same rotation as sequential matrix rotations', () => {
    const euler: [number, number, number] = [25, 35, 0];
    const degToRad = Math.PI / 180;
    
    // Build rotation matrix manually using intrinsic XYZ order
    // Intrinsic XYZ = first rotate around local X, then local Y, then local Z
    // Matrix multiplication: Rz * Ry * Rx (applied right-to-left)
    const rx = mat4.create();
    const ry = mat4.create();
    const rz = mat4.create();
    mat4.rotateX(rx, mat4.create(), euler[0] * degToRad);
    mat4.rotateY(ry, mat4.create(), euler[1] * degToRad);
    mat4.rotateZ(rz, mat4.create(), euler[2] * degToRad);
    
    // Intrinsic XYZ: apply X first, then Y, then Z in local space
    // This is equivalent to Rz * Ry * Rx in matrix notation
    const matrixResult = mat4.create();
    mat4.multiply(matrixResult, ry, rx);  // First combine X and Y
    mat4.multiply(matrixResult, rz, matrixResult);  // Then apply Z
    
    // Get rotation matrix from quaternion
    const q = eulerToQuat(euler);
    const quatResult = mat4.create();
    mat4.fromQuat(quatResult, q);
    
    // Test by transforming a point and comparing results
    const testPoint = vec3.fromValues(1, 0, 0);
    
    const matrixTransformed = vec3.create();
    vec3.transformMat4(matrixTransformed, testPoint, matrixResult);
    
    const quatTransformed = vec3.create();
    vec3.transformMat4(quatTransformed, testPoint, quatResult);
    
    expect(quatTransformed[0]).toBeCloseTo(matrixTransformed[0], 4);
    expect(quatTransformed[1]).toBeCloseTo(matrixTransformed[1], 4);
    expect(quatTransformed[2]).toBeCloseTo(matrixTransformed[2], 4);
  });
});
