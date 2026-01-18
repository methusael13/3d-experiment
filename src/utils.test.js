import { describe, it, expect } from 'vitest';
import { createViewMatrix, getTargetFromDirection, worldToCamera, perspectiveProject, cameraToScreen } from './utils';

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
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
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
      expect(closePoint.x).toBeGreaterThan(farPoint.x);
    });

    it('scales x and y inversely with distance', () => {
      const result = perspectiveProject({ x: 1, y: 1, z: -2 }, near, fov);
      expect(result.x).toBeCloseTo(0.5);
      expect(result.y).toBeCloseTo(0.5);
    });
  });

  describe('FOV handling', () => {
    it('narrower FOV makes objects appear larger', () => {
      const wideFov = perspectiveProject({ x: 1, y: 0, z: -2 }, near, Math.PI / 2);
      const narrowFov = perspectiveProject({ x: 1, y: 0, z: -2 }, near, Math.PI / 4);
      expect(narrowFov.x).toBeGreaterThan(wideFov.x);
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
