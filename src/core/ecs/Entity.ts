import type { ComponentType } from './types';
import type { Component } from './Component';

/**
 * An Entity is a lightweight container that holds components.
 * Entities have an ID and a name, but all behavior comes from their components.
 */
export class Entity {
  private static nextId = 1;

  readonly id: string;
  name: string;
  /** When true, this entity is hidden from UI panels (e.g., internal system entities like frustum cull). */
  internal = false;
  private components = new Map<ComponentType, Component>();

  constructor(name: string = 'Entity') {
    this.id = `entity-${Entity.nextId++}`;
    this.name = name;
  }

  /**
   * Add a component to this entity. Replaces existing component of the same type.
   * Returns the added component for chaining.
   */
  addComponent<T extends Component>(component: T): T {
    // Destroy existing component of same type if present
    const existing = this.components.get(component.type);
    if (existing) {
      existing.destroy?.();
    }
    this.components.set(component.type, component);
    return component;
  }

  /**
   * Remove a component by type. Returns the removed component or undefined.
   */
  removeComponent(type: ComponentType): Component | undefined {
    const component = this.components.get(type);
    if (component) {
      component.destroy?.();
      this.components.delete(type);
    }
    return component;
  }

  /**
   * Get a component by type. Returns undefined if not present.
   */
  getComponent<T extends Component>(type: ComponentType): T | undefined {
    return this.components.get(type) as T | undefined;
  }

  /**
   * Check if this entity has a specific component type.
   */
  hasComponent(type: ComponentType): boolean {
    return this.components.has(type);
  }

  /**
   * Check if this entity has ALL of the specified component types.
   */
  hasAll(...types: ComponentType[]): boolean {
    return types.every((type) => this.components.has(type));
  }

  /**
   * Check if this entity has ANY of the specified component types.
   */
  hasAny(...types: ComponentType[]): boolean {
    return types.some((type) => this.components.has(type));
  }

  /**
   * Get all component types present on this entity.
   */
  getComponentTypes(): ComponentType[] {
    return Array.from(this.components.keys());
  }

  /**
   * Iterate over all components.
   */
  getComponents(): IterableIterator<Component> {
    return this.components.values();
  }

  /**
   * Get the number of components.
   */
  get componentCount(): number {
    return this.components.size;
  }

  /**
   * Destroy this entity and all its components.
   */
  destroy(): void {
    for (const component of this.components.values()) {
      component.destroy?.();
    }
    this.components.clear();
  }
}