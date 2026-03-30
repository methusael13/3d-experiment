/**
 * EditorOverlayManager — Editor-specific debug overlay rendering
 *
 * Extracts all debug/editor overlay rendering from Viewport into a focused class.
 * Each overlay renders into a separate command encoder pass on top of the backbuffer.
 *
 * Overlays:
 *   - Light helper wireframes (arrows, spheres, cones)
 *   - Player helper wireframes (sphere + look-direction arrow)
 *   - Skeleton debug (bone lines + joint octahedra)
 *   - Camera frustum visualization (for debug camera mode)
 *   - Transform gizmo
 *
 * @see docs/engine-extraction-plan.md — Phase 3.1
 */

import { GPUContext } from '../../core/gpu/GPUContext';
import { LightVisualizerGPU } from '../../core/gpu/renderers/LightVisualizerGPU';
import { PlayerVisualizerGPU } from '../../core/gpu/renderers/PlayerVisualizerGPU';
import { SkeletonDebugRenderer } from '../../core/gpu/renderers/SkeletonDebugRenderer';
import { GizmoRendererGPU } from '../../core/gpu/renderers/GizmoRendererGPU';
import { CameraFrustumRendererGPU, type CSMDebugInfo } from '../../core/gpu/renderers/CameraFrustumRendererGPU';
import type { World } from '../../core/ecs/World';
import { LightComponent } from '../../core/ecs/components/LightComponent';
import type { CameraObject } from '../../core/sceneObjects';
import type { GPUForwardPipeline } from '../../core/gpu/pipeline/GPUForwardPipeline';
import type { TransformGizmoManager } from './gizmos';

export class EditorOverlayManager {
  private gpuContext: GPUContext;

  // GPU renderers
  private lightVisualizer: LightVisualizerGPU | null = null;
  private playerVisualizer: PlayerVisualizerGPU | null = null;
  private skeletonDebugRenderer: SkeletonDebugRenderer | null = null;
  private skeletonGizmoRenderer: GizmoRendererGPU | null = null;
  private cameraFrustumRenderer: CameraFrustumRendererGPU | null = null;

  constructor(gpuContext: GPUContext) {
    this.gpuContext = gpuContext;
    this.lightVisualizer = new LightVisualizerGPU(gpuContext);
    this.playerVisualizer = new PlayerVisualizerGPU(gpuContext);
    this.skeletonDebugRenderer = new SkeletonDebugRenderer();
    this.skeletonGizmoRenderer = new GizmoRendererGPU(gpuContext);
  }

  // ── Settings ──

  setShowLightHelpers(show: boolean): void {
    if (this.lightVisualizer) {
      this.lightVisualizer.enabled = show;
    }
  }

  // ── Render all active overlays ──

  renderAllOverlays(params: {
    world: World;
    vpMatrix: Float32Array;
    cameraPosition: [number, number, number];
    logicalHeight: number;
    fpsMode: boolean;
    debugCameraMode: boolean;
    sceneCamera?: CameraObject;
    debugCamera?: CameraObject;
    pipeline?: GPUForwardPipeline;
    gizmo?: TransformGizmoManager;
  }): void {
    const {
      world, vpMatrix, cameraPosition, logicalHeight,
      fpsMode, debugCameraMode,
      sceneCamera, debugCamera, pipeline, gizmo,
    } = params;

    // Debug camera frustum visualization
    if (debugCameraMode && sceneCamera && debugCamera && pipeline) {
      this.renderCameraFrustum(sceneCamera, debugCamera, pipeline, world);
    }

    // Light helpers (skip in FPS mode)
    if (!fpsMode) {
      this.renderLightHelpers(world, vpMatrix, cameraPosition, logicalHeight);
    }

    // Player helpers (skip in FPS mode)
    if (!fpsMode) {
      this.renderPlayerHelpers(world, vpMatrix, cameraPosition, logicalHeight);
    }

    // Skeleton debug
    this.renderSkeletonDebug(world, vpMatrix);

    // Gizmo (skip in FPS mode and debug camera mode)
    if (!fpsMode && !debugCameraMode && gizmo?.hasGPURenderer()) {
      this.renderGizmo(gizmo, vpMatrix);
    }
  }

  // ── Individual overlay renderers ──

  private renderLightHelpers(
    world: World,
    vpMatrix: Float32Array,
    cameraPosition: [number, number, number],
    logicalHeight: number,
  ): void {
    if (!this.lightVisualizer?.enabled) return;

    this.lightVisualizer.update(world);
    if (this.lightVisualizer.drawCount === 0) return;

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'light-helper-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'light-helper-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
      }],
    });

    this.lightVisualizer.render(passEncoder, vpMatrix, cameraPosition, logicalHeight);
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  private renderPlayerHelpers(
    world: World,
    vpMatrix: Float32Array,
    cameraPosition: [number, number, number],
    logicalHeight: number,
  ): void {
    if (!this.playerVisualizer?.enabled) return;

    this.playerVisualizer.update(world);
    if (this.playerVisualizer.drawCount === 0) return;

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'player-helper-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'player-helper-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
      }],
    });

    this.playerVisualizer.render(passEncoder, vpMatrix, cameraPosition, logicalHeight);
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  private renderSkeletonDebug(world: World, vpMatrix: Float32Array): void {
    if (!this.skeletonDebugRenderer || !this.skeletonGizmoRenderer) return;

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'skeleton-debug-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'skeleton-debug-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
      }],
    });

    this.skeletonDebugRenderer.render(passEncoder, vpMatrix, this.skeletonGizmoRenderer, world);
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  private renderCameraFrustum(
    sceneCamera: CameraObject,
    debugCamera: CameraObject,
    pipeline: GPUForwardPipeline,
    world: World,
  ): void {
    if (!this.cameraFrustumRenderer) {
      this.cameraFrustumRenderer = new CameraFrustumRendererGPU(this.gpuContext);
    }

    const pos = sceneCamera.getPosition();
    const target = sceneCamera.getTarget();

    // Build CSM debug info if available
    let csmInfo: CSMDebugInfo | undefined;
    const shadowRenderer = pipeline.getShadowRenderer();
    const shadowConfig = shadowRenderer.getConfig();
    if (shadowConfig.csmEnabled) {
      const sunEntity = world.queryFirst('light');
      const sunLc = sunEntity?.getComponent<LightComponent>('light');
      const lightDir = sunLc?.direction;
      if (lightDir) {
        csmInfo = {
          lightDirection: lightDir,
          cascadeCount: shadowConfig.cascadeCount,
          cascadeSplitLambda: shadowConfig.cascadeSplitLambda,
          shadowRadius: shadowConfig.shadowRadius,
        };
      }
    }

    this.cameraFrustumRenderer.updateFrustum(
      pos, target, sceneCamera.fov,
      1, // aspect ratio — will be overridden by actual canvas dimensions
      sceneCamera.near, sceneCamera.far, csmInfo,
    );

    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'camera-frustum-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'camera-frustum-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
      }],
    });

    const debugVP = debugCamera.getViewProjectionMatrix();
    this.cameraFrustumRenderer.render(passEncoder, debugVP as Float32Array);
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  private renderGizmo(gizmo: TransformGizmoManager, vpMatrix: Float32Array): void {
    const outputTexture = this.gpuContext.context?.getCurrentTexture();
    if (!outputTexture) return;

    const outputView = outputTexture.createView();
    const encoder = this.gpuContext.device.createCommandEncoder({
      label: 'gizmo-overlay-encoder',
    });

    const passEncoder = encoder.beginRenderPass({
      label: 'gizmo-overlay-pass',
      colorAttachments: [{
        view: outputView,
        loadOp: 'load' as GPULoadOp,
        storeOp: 'store' as GPUStoreOp,
      }],
    });

    gizmo.renderGPU(passEncoder, vpMatrix);
    passEncoder.end();
    this.gpuContext.queue.submit([encoder.finish()]);
  }

  // ── Cleanup ──

  destroy(): void {
    this.lightVisualizer?.destroy();
    this.lightVisualizer = null;
    this.playerVisualizer?.destroy();
    this.playerVisualizer = null;
    this.skeletonGizmoRenderer?.destroy();
    this.skeletonGizmoRenderer = null;
    this.skeletonDebugRenderer = null;
    this.cameraFrustumRenderer = null;
  }
}
