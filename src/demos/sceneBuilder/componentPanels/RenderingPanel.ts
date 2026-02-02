/**
 * RenderingPanel - Controls rendering settings like shadows, WebGPU mode, etc.
 * 
 * WebGPU Shadow System Parameters:
 * - resolution: Shadow map resolution (512-4096)
 * - shadowRadius: Coverage radius around camera (50-500m)
 * - shadowEnabled: Enable/disable shadows
 * - softShadows: Use PCF filtering for soft edges
 */

import type { PanelContext } from './panelContext';

export interface RenderingPanelAPI {
  update(): void;
  destroy(): void;
}

/** WebGPU shadow configuration (matches ShadowConfig) */
export interface WebGPUShadowSettings {
  enabled: boolean;
  resolution: number;
  shadowRadius: number;
  softShadows: boolean;
}

/**
 * RenderingPanel - UI for rendering settings
 */
export class RenderingPanel implements RenderingPanelAPI {
  private container: HTMLElement;
  private ctx: PanelContext;
  private panelEl: HTMLElement | null = null;

  constructor(container: HTMLElement, ctx: PanelContext) {
    this.container = container;
    this.ctx = ctx;
    this.render();
  }

  private render(): void {
    this.panelEl = document.createElement('div');
    this.panelEl.className = 'sidebar-section';
    this.panelEl.innerHTML = `
      <h3>Rendering</h3>
      <div class="section-content">
        <!-- WebGPU Shadows Section -->
        <div class="panel-group" id="webgpu-shadow-group">
          <div class="panel-group-title">Shadows (WebGPU)</div>
          
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-enabled" checked>
            Shadows Enabled
          </label>
          
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Resolution</label>
            </div>
            <select id="shadow-resolution" style="width: 100%; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; padding: 4px; font-size: 11px;">
              <option value="512">512</option>
              <option value="1024">1024</option>
              <option value="2048" selected>2048</option>
              <option value="4096">4096</option>
            </select>
          </div>
          
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Shadow Radius</label>
              <span class="slider-value" id="shadow-radius-val">200</span>
            </div>
            <input type="range" class="slider-input" id="shadow-radius" min="50" max="500" step="10" value="200">
          </div>
          
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-soft" checked>
            Soft Shadows (PCF)
          </label>
          
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-debug">
            Show Debug Thumbnail
          </label>
        </div>
        
        <!-- WebGPU Mode -->
        <div class="panel-group">
          <div class="panel-group-title">🧪 WebGPU Mode</div>
          <label class="checkbox-label">
            <input type="checkbox" id="webgpu-test-mode">
            Enable WebGPU Terrain
          </label>
          <div id="webgpu-status" style="font-size: 10px; color: #888; margin-top: 4px;"></div>
        </div>
        
        <!-- Future: Anti-aliasing, AO, Bloom -->
        <div class="panel-group panel-group-disabled">
          <div class="panel-group-title">Post Processing (coming soon)</div>
          <label class="checkbox-label disabled-row">
            <input type="checkbox" disabled>
            Anti-aliasing (FXAA)
          </label>
          <label class="checkbox-label disabled-row">
            <input type="checkbox" disabled>
            Ambient Occlusion (SSAO)
          </label>
          <label class="checkbox-label disabled-row">
            <input type="checkbox" disabled>
            Bloom
          </label>
        </div>
      </div>
    `;

    this.container.appendChild(this.panelEl);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    if (!this.panelEl) return;

    // Shadow enabled
    const shadowEnabled = this.panelEl.querySelector('#shadow-enabled') as HTMLInputElement;
    shadowEnabled?.addEventListener('change', () => {
      this.updateShadowSettings();
      this.toggleShadowUI(shadowEnabled.checked);
    });

    // Shadow resolution
    const resolutionSelect = this.panelEl.querySelector('#shadow-resolution') as HTMLSelectElement;
    resolutionSelect?.addEventListener('change', () => {
      this.updateShadowSettings();
    });

    // Shadow radius
    const radiusSlider = this.panelEl.querySelector('#shadow-radius') as HTMLInputElement;
    const radiusVal = this.panelEl.querySelector('#shadow-radius-val') as HTMLElement;
    radiusSlider?.addEventListener('input', () => {
      radiusVal.textContent = radiusSlider.value;
      this.updateShadowSettings();
    });

    // Soft shadows
    const softShadows = this.panelEl.querySelector('#shadow-soft') as HTMLInputElement;
    softShadows?.addEventListener('change', () => {
      this.updateShadowSettings();
    });

    // Shadow debug thumbnail
    const shadowDebug = this.panelEl.querySelector('#shadow-debug') as HTMLInputElement;
    shadowDebug?.addEventListener('change', () => {
      this.ctx.setShowShadowThumbnail?.(shadowDebug.checked);
    });

    // WebGPU test mode
    const webgpuTestCheckbox = this.panelEl.querySelector('#webgpu-test-mode') as HTMLInputElement;
    const webgpuStatus = this.panelEl.querySelector('#webgpu-status') as HTMLElement;
    webgpuTestCheckbox?.addEventListener('change', async () => {
      if (webgpuTestCheckbox.checked) {
        webgpuStatus.textContent = 'Initializing WebGPU...';
        webgpuStatus.style.color = '#ff9';
        
        const success = await this.ctx.enableWebGPUTest?.();
        if (success) {
          webgpuStatus.textContent = '✅ WebGPU active - rendering terrain';
          webgpuStatus.style.color = '#9f9';
          // Show shadow controls
          this.showWebGPUShadowControls(true);
        } else {
          webgpuStatus.textContent = '❌ WebGPU initialization failed';
          webgpuStatus.style.color = '#f99';
          webgpuTestCheckbox.checked = false;
        }
      } else {
        this.ctx.disableWebGPUTest?.();
        webgpuStatus.textContent = 'WebGPU disabled';
        webgpuStatus.style.color = '#888';
        // Shadow controls still visible but may be for legacy WebGL
      }
    });
  }

  /** Update shadow settings and notify context */
  private updateShadowSettings(): void {
    if (!this.panelEl) return;

    const enabled = (this.panelEl.querySelector('#shadow-enabled') as HTMLInputElement)?.checked ?? true;
    const resolution = parseInt((this.panelEl.querySelector('#shadow-resolution') as HTMLSelectElement)?.value ?? '2048', 10);
    const shadowRadius = parseFloat((this.panelEl.querySelector('#shadow-radius') as HTMLInputElement)?.value ?? '200');
    const softShadows = (this.panelEl.querySelector('#shadow-soft') as HTMLInputElement)?.checked ?? true;

    const settings: WebGPUShadowSettings = {
      enabled,
      resolution,
      shadowRadius,
      softShadows,
    };

    // Call context methods
    this.ctx.setShadowEnabled?.(enabled);
    this.ctx.setShadowResolution?.(resolution);
    this.ctx.setWebGPUShadowSettings?.(settings);
  }

  /** Toggle shadow UI enabled state */
  private toggleShadowUI(enabled: boolean): void {
    if (!this.panelEl) return;
    
    const shadowGroup = this.panelEl.querySelector('#webgpu-shadow-group');
    if (!shadowGroup) return;
    
    const controls = shadowGroup.querySelectorAll('input:not(#shadow-enabled), select');
    controls.forEach((control) => {
      (control as HTMLInputElement | HTMLSelectElement).disabled = !enabled;
    });
    
    const sliders = shadowGroup.querySelectorAll('.transform-group');
    sliders.forEach((slider) => {
      (slider as HTMLElement).style.opacity = enabled ? '1' : '0.5';
    });
  }

  /** Show/hide WebGPU-specific shadow controls */
  private showWebGPUShadowControls(show: boolean): void {
    if (!this.panelEl) return;
    
    const shadowGroup = this.panelEl.querySelector('#webgpu-shadow-group');
    if (shadowGroup) {
      (shadowGroup as HTMLElement).style.display = show ? 'block' : 'block'; // Always show for now
    }
  }

  update(): void {
    // Sync UI with current state if needed
    // For now, the panel maintains its own state
  }

  destroy(): void {
    if (this.panelEl) {
      this.panelEl.remove();
      this.panelEl = null;
    }
  }
}
