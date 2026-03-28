/**
 * TransitionEvaluator — Evaluates composable transition conditions against
 * CharacterVarsComponent runtime variables.
 *
 * Used by AnimationSystem to determine when animation state transitions
 * should fire based on user-defined TransitionRule conditions.
 *
 * Supports:
 * - Comparison: variable vs value (>, <, >=, <=, ==, !=)
 * - Input: check if an input action is active (via CharacterVarsComponent bools)
 * - ClipFinished: check if current clip/phase has finished playing
 * - Logical: AND, OR, NOT combinators
 */

import type { CharacterVarsComponent } from '../ecs/components/CharacterVarsComponent';
import type { TransitionCondition } from './types';

/**
 * Read a runtime variable by name from CharacterVarsComponent.
 * Checks built-in variables first, then custom floats/bools.
 */
export function readVariable(
  name: string,
  vars: CharacterVarsComponent,
): number | boolean {
  switch (name) {
    case 'speed':
    case 'horizontalSpeed':
      return vars.speed;
    case 'velY':
      return vars.velY;
    case 'grounded':
      return vars.grounded;
    case 'airTime':
      return vars.airTime;
    case 'currentStateTime':
      return vars.currentStateTime;
  }
  // Check custom floats first (more common), then bools
  const floatVal = vars.floats.get(name);
  if (floatVal !== undefined) return floatVal;
  const boolVal = vars.bools.get(name);
  if (boolVal !== undefined) return boolVal;
  return 0;
}

/**
 * Evaluate a TransitionCondition tree against runtime variables.
 *
 * @param cond The condition to evaluate
 * @param vars Runtime variables component
 * @param clipFinished Whether the current clip/phase has finished playing
 * @returns true if the condition is satisfied
 */
export function evaluateCondition(
  cond: TransitionCondition,
  vars: CharacterVarsComponent,
  clipFinished = false,
): boolean {
  switch (cond.type) {
    case 'comparison': {
      const val = readVariable(cond.variable, vars);
      const target = cond.value;
      switch (cond.operator) {
        case '>':  return (val as number) > (target as number);
        case '<':  return (val as number) < (target as number);
        case '>=': return (val as number) >= (target as number);
        case '<=': return (val as number) <= (target as number);
        case '==': return val === target;
        case '!=': return val !== target;
      }
      return false;
    }

    case 'input':
      // Input actions are stored as boolean vars: `input_<action>` for one-frame press,
      // `input_<action>_held` for sustained hold
      return vars.bools.get(`input_${cond.action}`) === true;

    case 'clipFinished':
      return clipFinished;

    case 'and':
      return cond.children.every(c => evaluateCondition(c, vars, clipFinished));

    case 'or':
      return cond.children.some(c => evaluateCondition(c, vars, clipFinished));

    case 'not':
      return cond.children.length > 0
        ? !evaluateCondition(cond.children[0], vars, clipFinished)
        : false;
  }
}
