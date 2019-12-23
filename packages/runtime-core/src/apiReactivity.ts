export {
  ref,
  isRef,
  toRefs,
  reactive,
  isReactive,
  readonly,
  isReadonly,
  toRaw,
  markReadonly,
  markNonReactive,
  effect,
  // types
  ReactiveEffect,
  ReactiveEffectOptions,
  DebuggerEvent,
  TrackOpTypes,
  TriggerOpTypes,
  Ref,
  ComputedRef,
  UnwrapRef,
  WritableComputedOptions
} from '@vue/reactivity'

import {
  computed as _computed,
  ComputedRef,
  WritableComputedOptions,
  ReactiveEffect,
  WritableComputedRef,
  ComputedGetter
} from '@vue/reactivity'

import { currentInstance } from './component'

// record effects created during a component's setup() so that they can be 副作用记录在组件实例的cur.effects对象上, 在setup()中生成
// stopped when the component unmounts
export function recordEffect(effect: ReactiveEffect) {
  if (currentInstance) {
    ;(currentInstance.effects || (currentInstance.effects = [])).push(effect)
  }
}

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  const c = _computed(getterOrOptions as any)
  recordEffect(c.effect)
  return c
}
