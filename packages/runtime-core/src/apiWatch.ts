import {
  effect,
  stop,
  isRef,
  Ref,
  ComputedRef,
  ReactiveEffectOptions
} from '@vue/reactivity'
import { queueJob } from './scheduler'
import {
  EMPTY_OBJ,
  isObject,
  isArray,
  isFunction,
  isString,
  hasChanged
} from '@vue/shared'
import { recordEffect } from './apiReactivity'
import {
  currentInstance,
  ComponentInternalInstance,
  currentSuspense,
  Data
} from './component'
import {
  ErrorCodes,
  callWithErrorHandling,
  callWithAsyncErrorHandling
} from './errorHandling'
import { onBeforeUnmount } from './apiLifecycle'
import { queuePostRenderEffect } from './renderer'

export type WatchHandler<T = any> = (
  value: T,
  oldValue: T,
  onCleanup: CleanupRegistrator // watch监听的第三个参数, 撤销监听?
) => any

export interface WatchOptions {
  lazy?: boolean
  flush?: 'pre' | 'post' | 'sync'
  deep?: boolean
  onTrack?: ReactiveEffectOptions['onTrack']
  onTrigger?: ReactiveEffectOptions['onTrigger']
}

type StopHandle = () => void

type WatcherSource<T = any> = Ref<T> | ComputedRef<T> | (() => T)

type MapSources<T> = {
  [K in keyof T]: T[K] extends WatcherSource<infer V> ? V : never
}

export type CleanupRegistrator = (invalidate: () => void) => void

type SimpleEffect = (onCleanup: CleanupRegistrator) => void

const invoke = (fn: Function) => fn()

// overload #1: simple effect
export function watch(effect: SimpleEffect, options?: WatchOptions): StopHandle

// overload #2: single source + cb
export function watch<T>(
  source: WatcherSource<T>,
  cb: WatchHandler<T>,
  options?: WatchOptions
): StopHandle

// overload #3: array of multiple sources + cb
// Readonly constraint helps the callback to correctly infer value types based
// on position in the source array. Otherwise the values will get a union type
// of all possible value types.
export function watch<T extends Readonly<WatcherSource<unknown>[]>>(
  sources: T,
  cb: WatchHandler<MapSources<T>>,
  options?: WatchOptions
): StopHandle

// implementation
export function watch<T = any>(
  effectOrSource: WatcherSource<T> | WatcherSource<T>[] | SimpleEffect,
  cbOrOptions?: WatchHandler<T> | WatchOptions,
  options?: WatchOptions
): StopHandle {
  if (isFunction(cbOrOptions)) {
    // effect callback as 2nd argument - this is a source watcher
    return doWatch(effectOrSource, cbOrOptions, options)
  } else {
    // 2nd argument is either missing or an options object
    // - this is a simple effect watcher
    return doWatch(effectOrSource, null, cbOrOptions)
  }
}

function doWatch(
  source: WatcherSource | WatcherSource[] | SimpleEffect,
  cb: WatchHandler | null,
  { lazy, deep, flush, onTrack, onTrigger }: WatchOptions = EMPTY_OBJ
): StopHandle {
  const instance = currentInstance
  const suspense = currentSuspense // suspence可能还有额外处理

  let getter: () => any // 生成watch的getter, 也就是依赖收集的点
  if (isArray(source)) {
    getter = () =>
      source.map(
        s =>
          isRef(s) // 监听this.**, 是一个响应式的value
            ? s.value
            : callWithErrorHandling(s, instance, ErrorCodes.WATCH_GETTER) // 或者自定义的watch函数比如: () => this.data.**
      )
  } else if (isRef(source)) {
    getter = () => source.value
  } else if (cb) {
    // getter with cb
    getter = () =>
      callWithErrorHandling(source, instance, ErrorCodes.WATCH_GETTER)
  } else {
    // no cb -> simple effect
    getter = () => {
      if (instance && instance.isUnmounted) { // 如果实例已经卸载直接返回
        return
      }
      if (cleanup) {
        cleanup()
      }
      return callWithErrorHandling(
        source,
        instance,
        ErrorCodes.WATCH_CALLBACK,
        [registerCleanup]
      )
    }
  }

  if (deep) { // deep处理
    const baseGetter = getter
    getter = () => traverse(baseGetter())
  }

  let cleanup: Function
  const registerCleanup: CleanupRegistrator = (fn: () => void) => {
    cleanup = runner.options.onStop = () => {
      callWithErrorHandling(fn, instance, ErrorCodes.WATCH_CLEANUP)
    }
  }

  let oldValue = isArray(source) ? [] : undefined // 可以监听一组值
  const applyCb = cb // watch的回调, 放在effect的scheduer里 ,每次set响应后调用
    ? () => {
        if (instance && instance.isUnmounted) { // 组件已卸载直接返回
          return
        }
        const newValue = runner()
        if (deep || hasChanged(newValue, oldValue)) {
          // cleanup before running cb again
          if (cleanup) {
            cleanup()
          }
          callWithAsyncErrorHandling(cb, instance, ErrorCodes.WATCH_CALLBACK, [
            newValue,
            oldValue,
            registerCleanup // watch的第三个参数是清除函数, 调用可以设置一个清除函数, 在停止监听和每次监听回调时调用一次
          ])
          oldValue = newValue
        }
      }
    : void 0

  let scheduler: (job: () => any) => void
  if (flush === 'sync') { // 同步任务直接调用cb
    scheduler = invoke
  } else if (flush === 'pre') { // 在组件前调用
    scheduler = job => {
      if (!instance || instance.vnode.el != null) {
        queueJob(job)
      } else {
        // with 'pre' option, the first call must happen before
        // the component is mounted so it is called synchronously.
        job()
      }
    }
  } else { // 默认操作, 加入刷新队列, 如果支持suspense, 加入此队列
    scheduler = job => {
      queuePostRenderEffect(job, suspense)
    }
  }

  const runner = effect(getter, {
    lazy: true,
    // so it runs before component update effects in pre flush mode
    computed: true,
    onTrack,
    onTrigger,
    scheduler: applyCb ? () => scheduler(applyCb) : scheduler // 如果没有watch的回调,那么每次scheduler默认传入的是当前的effect, (effect(), 即get依赖收集操作)
  })

  if (!lazy) {
    if (applyCb) {
      scheduler(applyCb)
    } else {
      scheduler(runner)
    }
  } else {
    oldValue = runner()
  }

  recordEffect(runner)
  return () => {
    stop(runner)
  }
}

// this.$watch
export function instanceWatch(
  this: ComponentInternalInstance,
  source: string | Function,
  cb: Function,
  options?: WatchOptions
): StopHandle {
  const ctx = this.proxy as Data
  const getter = isString(source) ? () => ctx[source] : source.bind(ctx)
  const stop = watch(getter, cb.bind(ctx), options)
  onBeforeUnmount(stop, this)
  return stop
}

// deep情况下的递归watch
function traverse(value: unknown, seen: Set<unknown> = new Set()) { // seen缓存去重
  if (!isObject(value) || seen.has(value)) {
    return
  }
  seen.add(value)
  if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      traverse(value[i], seen)
    }
  } else if (value instanceof Map) {
    value.forEach((v, key) => {
      // to register mutation dep for existing keys
      traverse(value.get(key), seen)
    })
  } else if (value instanceof Set) {
    value.forEach(v => {
      traverse(v, seen)
    })
  } else { // watch该对象的每个key, 每个值都加入到当前effect的deps中track
    for (const key in value) {
      traverse(value[key], seen) // getter时track
    }
  }
  return value
}
