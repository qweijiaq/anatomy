/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the LICENSE file
 * in the root directory of this source tree.
 */

import { Scheduler } from './scheduler'
import { LRUCache } from './lru-cache'

const cache = new LRUCache({ max: 50 })
const queue = []
const pending = new Map()

export const REACT_ELEMENT_TYPE = Symbol.for('react.element')

export function createElement(type, config, children) {
  const props = {}
  if (config != null) {
    for (const key in config) props[key] = config[key]
  }
  if (children !== undefined) props.children = children
  return { type, key: config == null ? null : config.key || null, props }
}

export function cloneElement(element, config, children) {
  const props = { ...element.props }
  if (children !== undefined) props.children = children
  return { ...element, props }
}

export function isValidElement(object) {
  return typeof object === 'object' && object !== null && object.$$typeof === REACT_ELEMENT_TYPE
}

export class Component {
  constructor(props) {
    this.props = props
  }

  render() {
    return null
  }
}

export class PureComponent extends Component {}

export function useState(initialState) {
  const slot = pending.get(initialState)
  if (slot !== undefined) return slot
  queue.push(initialState)
  return initialState
}

Scheduler.unstable_scheduleCallback(createElement, pending)
