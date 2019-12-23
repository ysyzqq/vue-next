export function patchDOMProp(
  el: any,
  key: string,
  value: any,
  // the following args are passed only due to potential innerHTML/textContent
  // overriding existing VNodes, in which case the old tree must be properly
  // unmounted.
  // 下面这几个参数是为了判断潜在的innerhtml覆盖了已经存在的vnode, 这种情况下要保证旧的vnode合理的卸载
  prevChildren: any,
  parentComponent: any,
  parentSuspense: any,
  unmountChildren: any
) {
  // 设置innerHTML或textContent的情况, 要将之前的vnode.children卸载
  if ((key === 'innerHTML' || key === 'textContent') && prevChildren != null) {
    unmountChildren(prevChildren, parentComponent, parentSuspense)
    el[key] = value == null ? '' : value
    return
  }
  if (key === 'value' && el.tagName !== 'PROGRESS') {
    // store value as _value as well since
    // non-string values will be stringified.
    el._value = value
    el.value = value == null ? '' : value
    return
  }
  if (value === '' && typeof el[key] === 'boolean') {
    // e.g. <select multiple> compiles to { multiple: '' }
    // 属性不赋值为true的处理
    el[key] = true
  } else {
    el[key] = value == null ? '' : value
  }
}
