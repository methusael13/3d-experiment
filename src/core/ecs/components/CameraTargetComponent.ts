/**
 * CameraTargetComponent — Defines third-person camera behavior.
 *
 * The camera orbits around the entity this is attached to, with mouse/stick
 * controlled yaw/pitch. Supports FPS (pointer-locked) and TPS orbit modes.
 *
 * In TPS mode:
 * - Mouse movement / right stick controls orbit yaw/pitch
 * - Scroll wheel / triggers control orbit distance (zoom)
 * - Camera smoothly interpolates to target position
 * - Terrain collision prevents camera going underground
 * - Optional velocity-driven sway/bob
 *
 * CameraSystem reads this component to compute the view matrix.
 * PlayerSystem writes to orbitYaw/orbitPitch from mouse/stick input.
 */

import { Component } from '../Component';
import type { ComponentType } from '../types';

export class CameraTargetComponent extends Component {
  readonly type: ComponentType = 'camera-target';

  // ==================== Mode ====================

  /** 'fps' = pointer-locked first-person; 'tps-orbit' = third-person orbit */
  mode: 'fps' | 'tps-orbit' = 'tps-orbit';

  // ==================== TPS Orbit State ====================
  // Written by PlayerSystem from mouse/stick input

  /** Horizontal orbit angle (degrees) */
  orbitYaw = 0;

  /** Vertical orbit angle above horizontal (degrees) */
  orbitPitch = 20;

  /** Distance from look-at point */
  orbitDistance = 5;

  // ==================== Look-At Offset ====================

  /** Offset from entity origin (typically head height) */
  lookAtOffset: [number, number, number] = [0, 1.5, 0];

  // ==================== Orbit Limits ====================

  minPitch = -10;
  maxPitch = 60;
  minDistance = 1.5;
  maxDistance = 15;

  // ==================== Mouse/Stick Sensitivity ====================

  /** Degrees per pixel (for TPS orbit control) */
  yawSensitivity = 0.3;
  pitchSensitivity = 0.3;

  /** Distance per scroll tick */
  zoomSensitivity = 0.5;

  /** Initial yaw offset (degrees) — added to orbitYaw to set default camera angle */
  initialYawOffset = 0;

  // ==================== Smoothing ====================

  /** Camera position lerp factor (higher = snappier) */
  positionSmoothSpeed = 8.0;

  /** Camera rotation lerp factor */
  rotationSmoothSpeed = 12.0;

  // ==================== Collision ====================

  /** Prevent camera inside terrain */
  collisionEnabled = true;

  /** Camera collision sphere radius */
  collisionRadius = 0.2;

  // ==================== Camera Sway (velocity-driven) ====================

  swayEnabled = false;
  swayAmplitude = 0.02;
  swayFrequency = 2.0;
  bobIntensity = 0.03;

  // ==================== Internal Smoothed State ====================
  // Written by CameraSystem — do not set manually

  _currentPosition: [number, number, number] = [0, 5, -5];
  _currentLookAt: [number, number, number] = [0, 0, 0];
  _initialized = false;

  constructor(options?: {
    mode?: 'fps' | 'tps-orbit';
    orbitYaw?: number;
    orbitPitch?: number;
    orbitDistance?: number;
    lookAtOffset?: [number, number, number];
    minPitch?: number;
    maxPitch?: number;
    minDistance?: number;
    maxDistance?: number;
    yawSensitivity?: number;
    pitchSensitivity?: number;
    zoomSensitivity?: number;
    positionSmoothSpeed?: number;
    rotationSmoothSpeed?: number;
    collisionEnabled?: boolean;
    collisionRadius?: number;
    swayEnabled?: boolean;
    swayAmplitude?: number;
    swayFrequency?: number;
    bobIntensity?: number;
  }) {
    super();
    if (options) {
      if (options.mode !== undefined) this.mode = options.mode;
      if (options.orbitYaw !== undefined) this.orbitYaw = options.orbitYaw;
      if (options.orbitPitch !== undefined) this.orbitPitch = options.orbitPitch;
      if (options.orbitDistance !== undefined) this.orbitDistance = options.orbitDistance;
      if (options.lookAtOffset !== undefined) this.lookAtOffset = [...options.lookAtOffset];
      if (options.minPitch !== undefined) this.minPitch = options.minPitch;
      if (options.maxPitch !== undefined) this.maxPitch = options.maxPitch;
      if (options.minDistance !== undefined) this.minDistance = options.minDistance;
      if (options.maxDistance !== undefined) this.maxDistance = options.maxDistance;
      if (options.yawSensitivity !== undefined) this.yawSensitivity = options.yawSensitivity;
      if (options.pitchSensitivity !== undefined) this.pitchSensitivity = options.pitchSensitivity;
      if (options.zoomSensitivity !== undefined) this.zoomSensitivity = options.zoomSensitivity;
      if (options.positionSmoothSpeed !== undefined) this.positionSmoothSpeed = options.positionSmoothSpeed;
      if (options.rotationSmoothSpeed !== undefined) this.rotationSmoothSpeed = options.rotationSmoothSpeed;
      if (options.collisionEnabled !== undefined) this.collisionEnabled = options.collisionEnabled;
      if (options.collisionRadius !== undefined) this.collisionRadius = options.collisionRadius;
      if (options.swayEnabled !== undefined) this.swayEnabled = options.swayEnabled;
      if (options.swayAmplitude !== undefined) this.swayAmplitude = options.swayAmplitude;
      if (options.swayFrequency !== undefined) this.swayFrequency = options.swayFrequency;
      if (options.bobIntensity !== undefined) this.bobIntensity = options.bobIntensity;
    }
  }
}
