import type Spell from 'common/SPELLS/Spell';
import {
  AnyEvent,
  EventType,
  UpdateSpellUsableEvent,
  CastEvent,
  Ability,
} from 'parser/core/Events';
import metric, { Info } from 'parser/core/metric';

interface Condition<T> {
  key: string;
  // produce the initial state object
  init: () => T;
  // Update the internal condition state
  update: (state: T, event: AnyEvent) => T;
  // validate whether the condition applies for the supplied event.
  validate: (state: T, event: AnyEvent) => boolean;
}
export interface ConditionalRule {
  spell: Spell;
  condition: Condition<any>;
}
export type Rule = Spell | ConditionalRule;

export interface Apl {
  conditions?: Array<Condition<any>>;
  rules: Rule[];
}

interface Violation {
  actualCast: Ability;
  expectedCast: Spell;
  rule: Rule;
}

type ConditionState = { [key: string]: any };
type AbilityState = { [spellId: number]: UpdateSpellUsableEvent };

interface CheckState {
  successes: Rule[];
  violations: Violation[];
  conditionState: ConditionState;
  abilityState: AbilityState;
}

export type CheckResult = Pick<CheckState, 'successes' | 'violations'>;

export function buffPresent(spell: Spell, target: number): Condition<boolean> {
  return {
    key: `buffPresent-${spell.id}-${target}`,
    init: () => false,
    update: (state, event) => {
      switch (event.type) {
        case EventType.ApplyBuff:
          if (event.ability.guid === spell.id) {
            return true;
          }
          break;
        case EventType.RemoveBuff:
          if (event.ability.guid === spell.id) {
            return false;
          }
          break;
      }

      return state;
    },
    validate: (state, _event) => state,
  };
}

function initState(apl: Apl): ConditionState {
  return (
    apl.conditions?.reduce(
      (state: ConditionState, cnd: Condition<any>) => ({
        ...state,
        [cnd.key]: cnd.init(),
      }),
      {},
    ) || {}
  );
}

function updateState(apl: Apl, oldState: ConditionState, event: AnyEvent): ConditionState {
  return (
    apl.conditions?.reduce(
      (state: ConditionState, cnd: Condition<any>) => ({
        ...state,
        [cnd.key]: cnd.update(oldState[cnd.key], event),
      }),
      {},
    ) || {}
  );
}

const spell = (rule: Rule): Spell => ('spell' in rule ? rule.spell : rule);

/**
 * Check whether a rule applies to the given cast. There are two checks:
 *
 * 1. The spell the rule governs is available, and
 * 2. The condition for the rule is validated *or* the rule is unconditional.
 **/
function ruleApplies(rule: Rule, result: CheckState, event: CastEvent): boolean {
  return (
    (result.abilityState[spell(rule).id] === undefined ||
      result.abilityState[spell(rule).id].isAvailable) &&
    (!('condition' in rule) ||
      rule.condition.validate(result.conditionState[rule.condition.key], event))
  );
}

/**
 * Find the first applicable rule. See also: `ruleApplies`
 **/
function applicableRule(apl: Apl, result: CheckState, event: CastEvent): Rule | undefined {
  for (const rule of apl.rules) {
    if (ruleApplies(rule, result, event)) {
      return rule;
    }
  }
}

function updateAbilities(state: AbilityState, event: AnyEvent): AbilityState {
  if (event.type === EventType.UpdateSpellUsable) {
    state[event.ability.guid] = event;
  }
  return state;
}

const aplCheck = (apl: Apl) =>
  metric<[Info], CheckResult>((events, { playerId }) => {
    const applicableSpells = new Set(apl.rules.map((rule) => spell(rule).id));
    return events.reduce<CheckState>(
      (result, event) => {
        if (event.type === EventType.Cast && applicableSpells.has(event.ability.guid)) {
          const rule = applicableRule(apl, result, event);
          if (rule) {
            if (spell(rule).id === event.ability.guid) {
              // the player cast the correct spell
              result.successes.push(rule);
            } else {
              result.violations.push({
                rule,
                expectedCast: spell(rule),
                actualCast: event.ability,
              });
            }
          }
        }

        return {
          ...result,
          abilityState: updateAbilities(result.abilityState, event),
          conditionState: updateState(apl, result.conditionState, event),
        };
      },
      { successes: [], violations: [], abilityState: {}, conditionState: initState(apl) },
    );
  });

export default aplCheck;
