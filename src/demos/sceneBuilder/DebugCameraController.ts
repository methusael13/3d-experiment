/**
 * DebugCameraController - Global/meta camera for debug viewing
 * 
 * This camera is NOT part of the scene. It provides an independent viewpoint
 * while the scene camera continues to drive shadows, culling, and shader uniforms.
 * 
 * When activated, it copies the current scene camera state and allows
 * independent orbit/pan/zoom navigation.
 */

import { mat4 } from 'gl-matrix';
import { CameraObject } from '../../core/sceneObjects/CameraObject';
import type { InputManager, InputEvent, InputEventType } from './InputManager';

export interface DebugCameraOptions {
  width: number;
  height: number;
  inputManager: InputManager;
}

export class DebugCameraController {
  private readonly camera: CameraObject;
  private readonly inputManager: InputManager;
  private readonly width: number;
  private readonly height: number;

  // Input state
  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;
  private hasMoved = false;
  private mouseDownX = 0;
  private mouseDownY = 0;

  // Stored handler references for unsubscribe
  private registeredHandlers: { eventType: InputEventType; handler: any }[] = [];

  constructor(options: DebugCameraOptions) {
    this.width = options.width;
    this.height = options.height;
    this.inputManager = options.inputManager;

    this.camera = new CameraObject('DebugCamera');
    this.camera.setAspectRatio(options.width, options.height);
    // Give the debug camera a large far plane so it can see everything
    this.camera.setClipPlanes(0.1, 5000);
  }

  /**
   * Initialize from the current scene camera state so the debug camera
   * starts at the same viewpoint.
   */
  initFromSceneCamera(sceneCamera: CameraObject): void {
    const state = sceneCamera.getOrbitState();
    this.camera.setOrbitState(state);
    // Copy projection settings
    this.camera.fov = sceneCamera.fov;
    this.camera.near = sceneCamera.near;
    this.camera.far = Math.max(sceneCamera.far, 5000);
    this.camera.setZoomLimits(0.1, 5000);
  }

  /**
   * Subscribe to InputManager on the 'debug-camera' channel.
   */
  activate(): void {
    this.deactivate(); // Clean up any existing subscriptions

    const im = this.inputManager;

    const mousedownHandler = (e: InputEvent<MouseEvent>) => this.handleMouseDown(e);
    const mousemoveHandler = (e: InputEvent<MouseEvent>) => this.handleMouseMove(e);
    const mouseupHandler = (e: InputEvent<MouseEvent>) => this.handleMouseUp(e);
    const mouseleaveHandler = () => this.handleMouseLeave();
    const wheelHandler = (e: InputEvent<WheelEvent>) => this.handleWheel(e);

    im.on('debug-camera', 'mousedown', mousedownHandler);
    im.on('debug-camera', 'mousemove', mousemoveHandler);
    im.on('debug-camera', 'mouseup', mouseupHandler);
    im.on('debug-camera', 'mouseleave', mouseleaveHandler);
    im.on('debug-camera', 'wheel', wheelHandler);

    this.registeredHandlers = [
      { eventType: 'mousedown', handler: mousedownHandler },
      { eventType: 'mousemove', handler: mousemoveHandler },
      { eventType: 'mouseup', handler: mouseupHandler },
      { eventType: 'mouseleave', handler: mouseleaveHandler },
      { eventType: 'wheel', handler: wheelHandler },
    ];
  }

  /**
   * Remove all input subscriptions.
   */
  deactivate(): void {
    const im = this.inputManager;
    for (const { eventType, handler } of this.registeredHandlers) {
      im.off('debug-camera', eventType, handler);
    }
    this.registeredHandlers = [];
    this.isDragging = false;
    this.isPanning = false;
  }

  // ==================== Input Handlers ====================

  private handleMouseDown(e: InputEvent<MouseEvent>): void {
    if (e.button === 0) this.isDragging = true;
    else if (e.button === 2) this.isPanning = true;

    this.lastX = e.originalEvent.clientX;
    this.lastY = e.originalEvent.clientY;
    this.mouseDownX = e.originalEvent.clientX;
    this.mouseDownY = e.originalEvent.clientY;
    this.hasMoved = false;
  }

  private handleMouseMove(e: InputEvent<MouseEvent>): void {
    const clientX = e.originalEvent.clientX;
    const clientY = e.originalEvent.clientY;

    const dx = clientX - this.lastX;
    const dy = clientY - this.lastY;
    this.lastX = clientX;
    this.lastY = clientY;

    if (Math.abs(clientX - this.mouseDownX) > 3 || Math.abs(clientY - this.mouseDownY) > 3) {
      this.hasMoved = true;
    }

    if (this.isDragging && this.hasMoved) {
      this.camera.orbitBy(dx * 0.01, dy * 0.01);
    } else if (this.isPanning) {
      this.camera.panBy(dx, dy);
    }
  }

  private handleMouseUp(_e: InputEvent<MouseEvent>): void {
    this.isDragging = false;
    this.isPanning = false;
  }

  private handleMouseLeave(): void {
    this.isDragging = false;
    this.isPanning = false;
  }

  private handleWheel(e: InputEvent<WheelEvent>): void {
    this.camera.zoomBy(e.deltaY || 0);
  }

  // ==================== Accessors ====================

  getCamera(): CameraObject {
    return this.camera;
  }

  getViewProjectionMatrix(): mat4 {
    return this.camera.getViewProjectionMatrix();
  }

  destroy(): void {
    this.deactivate();
  }
}