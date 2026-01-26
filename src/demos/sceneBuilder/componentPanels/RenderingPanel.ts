/**
 * RenderingPanel - Controls rendering settings like shadows, contact shadows, etc.
 */

import type { PanelContext } from './panelContext';
import type { ContactShadowSettings } from '../../../core/renderers';

export interface RenderingPanelAPI {
  update(): void;
  destroy(): void;
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
        <!-- Shadow Map Section -->
        <div class="panel-group">
          <div class="panel-group-title">Shadow Map</div>
          
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
          
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-enabled" checked>
            Shadows Enabled
          </label>
          
          <label class="checkbox-label">
            <input type="checkbox" id="shadow-debug">
            Show Debug Thumbnail
          </label>
        </div>
        
        <!-- Contact Shadows Section -->
        <div class="panel-group">
          <div class="panel-group-title">Contact Shadows (SSCS)</div>
          
          <label class="checkbox-label">
            <input type="checkbox" id="contact-shadow-enabled" checked>
            Enabled
          </label>
          
          <div class="transform-group compact-slider" id="contact-shadow-settings">
            <div class="slider-header">
              <label>Quality</label>
            </div>
            <select id="contact-shadow-steps" style="width: 100%; background: #333; color: #f0f0f0; border: 1px solid #555; border-radius: 3px; padding: 4px; font-size: 11px;">
              <option value="8">Low (8 steps)</option>
              <option value="16" selected>Medium (16 steps)</option>
              <option value="32">High (32 steps)</option>
            </select>
          </div>
          
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Max Distance</label>
              <span class="slider-value" id="contact-shadow-distance-val">1.0</span>
            </div>
            <input type="range" class="slider-input" id="contact-shadow-distance" min="0.1" max="3" step="0.1" value="1">
          </div>
          
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Intensity</label>
              <span class="slider-value" id="contact-shadow-intensity-val">0.8</span>
            </div>
            <input type="range" class="slider-input" id="contact-shadow-intensity" min="0" max="1" step="0.05" value="0.8">
          </div>
          
          <div class="transform-group compact-slider">
            <div class="slider-header">
              <label>Thickness</label>
              <span class="slider-value" id="contact-shadow-thickness-val">0.10</span>
            </div>
            <input type="range" class="slider-input" id="contact-shadow-thickness" min="0.01" max="0.5" step="0.01" value="0.1">
          </div>
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

    // Shadow resolution
    const resolutionSelect = this.panelEl.querySelector('#shadow-resolution') as HTMLSelectElement;
    resolutionSelect?.addEventListener('change', () => {
      const res = parseInt(resolutionSelect.value, 10);
      this.ctx.setShadowResolution?.(res);
    });

    // Shadow enabled
    const shadowEnabled = this.panelEl.querySelector('#shadow-enabled') as HTMLInputElement;
    shadowEnabled?.addEventListener('change', () => {
      this.ctx.setShadowEnabled?.(shadowEnabled.checked);
    });

    // Shadow debug thumbnail
    const shadowDebug = this.panelEl.querySelector('#shadow-debug') as HTMLInputElement;
    shadowDebug?.addEventListener('change', () => {
      this.ctx.setShowShadowThumbnail?.(shadowDebug.checked);
    });

    // Contact shadow enabled
    const contactEnabled = this.panelEl.querySelector('#contact-shadow-enabled') as HTMLInputElement;
    contactEnabled?.addEventListener('change', () => {
      this.updateContactShadowSettings();
      this.toggleContactShadowUI(contactEnabled.checked);
    });

    // Contact shadow steps
    const contactSteps = this.panelEl.querySelector('#contact-shadow-steps') as HTMLSelectElement;
    contactSteps?.addEventListener('change', () => this.updateContactShadowSettings());

    // Contact shadow distance
    const distanceSlider = this.panelEl.querySelector('#contact-shadow-distance') as HTMLInputElement;
    const distanceVal = this.panelEl.querySelector('#contact-shadow-distance-val') as HTMLElement;
    distanceSlider?.addEventListener('input', () => {
      distanceVal.textContent = parseFloat(distanceSlider.value).toFixed(1);
      this.updateContactShadowSettings();
    });

    // Contact shadow intensity
    const intensitySlider = this.panelEl.querySelector('#contact-shadow-intensity') as HTMLInputElement;
    const intensityVal = this.panelEl.querySelector('#contact-shadow-intensity-val') as HTMLElement;
    intensitySlider?.addEventListener('input', () => {
      intensityVal.textContent = parseFloat(intensitySlider.value).toFixed(1);
      this.updateContactShadowSettings();
    });

    // Contact shadow thickness
    const thicknessSlider = this.panelEl.querySelector('#contact-shadow-thickness') as HTMLInputElement;
    const thicknessVal = this.panelEl.querySelector('#contact-shadow-thickness-val') as HTMLElement;
    thicknessSlider?.addEventListener('input', () => {
      thicknessVal.textContent = parseFloat(thicknessSlider.value).toFixed(2);
      this.updateContactShadowSettings();
    });
  }

  private updateContactShadowSettings(): void {
    if (!this.panelEl) return;

    const enabled = (this.panelEl.querySelector('#contact-shadow-enabled') as HTMLInputElement)?.checked ?? true;
    const steps = parseInt((this.panelEl.querySelector('#contact-shadow-steps') as HTMLSelectElement)?.value ?? '16', 10);
    const maxDistance = parseFloat((this.panelEl.querySelector('#contact-shadow-distance') as HTMLInputElement)?.value ?? '1');
    const intensity = parseFloat((this.panelEl.querySelector('#contact-shadow-intensity') as HTMLInputElement)?.value ?? '0.8');
    const thickness = parseFloat((this.panelEl.querySelector('#contact-shadow-thickness') as HTMLInputElement)?.value ?? '0.1');

    const settings: ContactShadowSettings = {
      enabled,
      steps,
      maxDistance,
      intensity,
      thickness,
    };

    this.ctx.setContactShadowSettings?.(settings);
  }

  private toggleContactShadowUI(enabled: boolean): void {
    if (!this.panelEl) return;
    
    const settingsContainer = this.panelEl.querySelector('#contact-shadow-settings')?.parentElement;
    const rows = this.panelEl.querySelectorAll('.panel-group:nth-child(2) .panel-row:not(:first-child)');
    rows.forEach((row) => {
      (row as HTMLElement).style.opacity = enabled ? '1' : '0.5';
      const inputs = row.querySelectorAll('input, select');
      inputs.forEach((input) => {
        if (input.id !== 'contact-shadow-enabled') {
          (input as HTMLInputElement | HTMLSelectElement).disabled = !enabled;
        }
      });
    });
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
