/**
 * Character Controller Node Port Types — Defines data flow types
 * for the character controller node graph domain.
 */

/** Data type flowing through character controller graph edges */
export type CCPortDataType =
  | 'inputIntent'      // Input Node → Character Node
  | 'characterState'   // Character Node → Camera Node / Anim Node / Script Node
  | 'terrainData'      // Terrain Node → Character Node
  | 'any';

/** Port direction */
export type PortDirection = 'input' | 'output';

/** Port definition for a character controller node */
export interface CCPortDef {
  id: string;
  label: string;
  type: CCPortDataType;
  direction: PortDirection;
}

/** Full port layout for a node type */
export interface CCNodePortLayout {
  inputs: CCPortDef[];
  outputs: CCPortDef[];
}

// ============================================================================
// Port layouts per node type
// ============================================================================

export const characterPortLayout: CCNodePortLayout = {
  inputs: [
    { id: 'input', label: 'Input', type: 'inputIntent', direction: 'input' },
    { id: 'terrain', label: 'Terrain', type: 'terrainData', direction: 'input' },
  ],
  outputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'output' },
  ],
};

export const inputPortLayout: CCNodePortLayout = {
  inputs: [],
  outputs: [
    { id: 'intent', label: 'Intent', type: 'inputIntent', direction: 'output' },
  ],
};

export const cameraPortLayout: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

export const animStateMachinePortLayout: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

export const terrainPortLayout: CCNodePortLayout = {
  inputs: [],
  outputs: [
    { id: 'terrain', label: 'Terrain', type: 'terrainData', direction: 'output' },
  ],
};

export const scriptPortLayout: CCNodePortLayout = {
  inputs: [
    { id: 'characterState', label: 'Character State', type: 'characterState', direction: 'input' },
  ],
  outputs: [],
};

/** Map of node type → port layout */
export const nodePortLayouts: Record<string, CCNodePortLayout> = {
  character: characterPortLayout,
  input: inputPortLayout,
  camera: cameraPortLayout,
  animStateMachine: animStateMachinePortLayout,
  terrain: terrainPortLayout,
  script: scriptPortLayout,
};
