/**
 * InputManager - Central event routing for editor input
 * 
 * Provides channel-based event routing so different input consumers
 * (orbit camera, FPS camera, gizmos) can receive events without
 * redundant enabled checks.
 * 
 * Channels:
 * - 'editor': Orbit camera + gizmo controls (default)
 * - 'fps': FPS camera controls
 * - 'global': Always receives events (keyboard shortcuts, etc.)
 */

export type InputChannel = 'editor' | 'fps' | 'global';

export type InputEventType = 
  | 'mousedown' 
  | 'mousemove' 
  | 'mouseup' 
  | 'wheel' 
  | 'keydown' 
  | 'keyup' 
  | 'dblclick'
  | 'contextmenu'
  | 'mouseleave'
  | 'pointermove'       // Pointer-locked mouse movement (movementX/Y)
  | 'pointerlockchange'; // Pointer lock state changed

export interface InputEvent<T = Event> {
  originalEvent: T;
  x: number;
  y: number;
  button?: number;
  deltaY?: number;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  // Pointer lock mouse movement
  movementX?: number;
  movementY?: number;
  // Pointer lock state
  locked?: boolean;
}

type EventHandler<T = Event> = (event: InputEvent<T>) => void | boolean;

interface ChannelHandlers {
  [eventType: string]: Set<EventHandler<any>>;
}

/**
 * InputManager handles all raw DOM events and routes them to subscribed channels.
 * Only the active channel + global channel receive events.
 */
export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private activeChannel: InputChannel = 'editor';
  
  // Handlers per channel per event type
  private handlers: Map<InputChannel, ChannelHandlers> = new Map();
  
  // Bound event handler references for cleanup
  private boundHandlers: Map<string, EventListener> = new Map();
  
  // Pointer lock state
  private pointerLocked = false;
  private boundPointerLockChange: (() => void) | null = null;
  private boundPointerLockMouseMove: ((e: MouseEvent) => void) | null = null;
  
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    
    // Initialize channel handler maps
    this.handlers.set('editor', {});
    this.handlers.set('fps', {});
    this.handlers.set('global', {});
    
    this.setupEventListeners();
    this.setupPointerLockListeners();
  }
  
  // ==================== Pointer Lock Management ====================
  
  /**
   * Request pointer lock on the canvas
   */
  requestPointerLock(): void {
    this.canvas.requestPointerLock();
  }
  
  /**
   * Exit pointer lock
   */
  exitPointerLock(): void {
    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
  }
  
  /**
   * Check if pointer is currently locked
   */
  isPointerLocked(): boolean {
    return this.pointerLocked;
  }
  
  /**
   * Set up pointer lock event listeners (document level)
   */
  private setupPointerLockListeners(): void {
    // Track pointer lock state changes
    this.boundPointerLockChange = () => {
      const wasLocked = this.pointerLocked;
      this.pointerLocked = document.pointerLockElement === this.canvas;
      
      if (wasLocked !== this.pointerLocked) {
        this.dispatch('pointerlockchange', {
          originalEvent: new Event('pointerlockchange'),
          x: 0,
          y: 0,
          locked: this.pointerLocked,
        });
      }
    };
    
    document.addEventListener('pointerlockchange', this.boundPointerLockChange);
    
    // Track mouse movement when pointer is locked
    this.boundPointerLockMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return;
      
      // Dispatch pointermove with movement deltas
      this.dispatch('pointermove', {
        originalEvent: e,
        x: 0,
        y: 0,
        movementX: e.movementX,
        movementY: e.movementY,
      });
    };
    
    document.addEventListener('mousemove', this.boundPointerLockMouseMove);
  }
  
  // ==================== Channel Management ====================
  
  /**
   * Set the active input channel
   */
  setActiveChannel(channel: InputChannel): void {
    if (channel === 'global') {
      console.warn('[InputManager] Cannot set global as active channel');
      return;
    }
    this.activeChannel = channel;
    console.log(`[InputManager] Active channel: ${channel}`);
  }
  
  /**
   * Get the current active channel
   */
  getActiveChannel(): InputChannel {
    return this.activeChannel;
  }
  
  // ==================== Event Subscription ====================
  
  /**
   * Subscribe to events on a specific channel
   */
  on<T extends Event>(
    channel: InputChannel,
    eventType: InputEventType,
    handler: EventHandler<T>
  ): void {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers) return;
    
    if (!channelHandlers[eventType]) {
      channelHandlers[eventType] = new Set();
    }
    channelHandlers[eventType].add(handler);
  }
  
  /**
   * Unsubscribe from events
   */
  off<T extends Event>(
    channel: InputChannel,
    eventType: InputEventType,
    handler: EventHandler<T>
  ): void {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers || !channelHandlers[eventType]) return;
    
    channelHandlers[eventType].delete(handler);
  }
  
  // ==================== Event Dispatching ====================
  
  /**
   * Dispatch event to active channel + global channel
   */
  private dispatch<T extends Event>(eventType: InputEventType, event: InputEvent<T>): boolean {
    let handled = false;
    
    // Global handlers first
    handled = this.dispatchToChannel('global', eventType, event) || handled;
    
    // Then active channel
    handled = this.dispatchToChannel(this.activeChannel, eventType, event) || handled;
    
    return handled;
  }
  
  /**
   * Dispatch to a specific channel
   */
  private dispatchToChannel<T extends Event>(
    channel: InputChannel,
    eventType: InputEventType,
    event: InputEvent<T>
  ): boolean {
    const channelHandlers = this.handlers.get(channel);
    if (!channelHandlers || !channelHandlers[eventType]) return false;
    
    let handled = false;
    for (const handler of channelHandlers[eventType]) {
      const result = handler(event);
      if (result === true) {
        handled = true;
      }
    }
    return handled;
  }
  
  // ==================== DOM Event Setup ====================
  
  private setupEventListeners(): void {
    const canvas = this.canvas;
    
    // Mouse events
    this.addListener(canvas, 'mousedown', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.dispatch('mousedown', {
        originalEvent: e,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    });
    
    this.addListener(canvas, 'mousemove', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.dispatch('mousemove', {
        originalEvent: e,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    });
    
    this.addListener(canvas, 'mouseup', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.dispatch('mouseup', {
        originalEvent: e,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        button: e.button,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    });
    
    this.addListener(canvas, 'mouseleave', (e: MouseEvent) => {
      this.dispatch('mouseleave', {
        originalEvent: e,
        x: 0,
        y: 0,
      });
    });
    
    this.addListener(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.dispatch('wheel', {
        originalEvent: e,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        deltaY: e.deltaY,
      });
    }, { passive: false });
    
    this.addListener(canvas, 'dblclick', (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      this.dispatch('dblclick', {
        originalEvent: e,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    });
    
    this.addListener(canvas, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      this.dispatch('contextmenu', {
        originalEvent: e,
        x: 0,
        y: 0,
      });
    });
    
    // Keyboard events on document (for global shortcuts)
    this.addListener(document, 'keydown', (e: KeyboardEvent) => {
      this.dispatch('keydown', {
        originalEvent: e,
        x: 0,
        y: 0,
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    });
    
    this.addListener(document, 'keyup', (e: KeyboardEvent) => {
      this.dispatch('keyup', {
        originalEvent: e,
        x: 0,
        y: 0,
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      });
    });
  }
  
  private addListener<K extends keyof HTMLElementEventMap>(
    element: HTMLElement | Document,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void {
    const boundHandler = handler as EventListener;
    this.boundHandlers.set(`${element === document ? 'doc' : 'canvas'}-${type}`, boundHandler);
    element.addEventListener(type, boundHandler, options);
  }
  
  // ==================== Cleanup ====================
  
  destroy(): void {
    // Remove canvas listeners
    for (const [key, handler] of this.boundHandlers) {
      const [target, type] = key.split('-');
      const element = target === 'doc' ? document : this.canvas;
      element.removeEventListener(type, handler);
    }
    this.boundHandlers.clear();
    
    // Remove pointer lock listeners
    if (this.boundPointerLockChange) {
      document.removeEventListener('pointerlockchange', this.boundPointerLockChange);
    }
    if (this.boundPointerLockMouseMove) {
      document.removeEventListener('mousemove', this.boundPointerLockMouseMove);
    }
    
    // Exit pointer lock if active
    if (this.pointerLocked) {
      this.exitPointerLock();
    }
    
    // Clear all handlers
    for (const channelHandlers of this.handlers.values()) {
      for (const handlers of Object.values(channelHandlers)) {
        handlers.clear();
      }
    }
  }
}
