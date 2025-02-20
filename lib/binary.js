/**
 * @private
 * [modified]: modifications belong in the public domain.
 *
 * Original source: https://github.com/surma/bfwasm
 * Original license:
 * Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { int, uint, bigint, f32, f64 } from './leb128.js'
import { BYTE } from './const.js'

export function wrap_instr (code) {
  return function (args, exprs) {
    return instr(
      code,
       args != null && !Array.isArray(args)  ? [args]  : args,
      exprs != null && !Array.isArray(exprs) ? [exprs] : exprs,
    )
  }
}

const encoding = {
  'f64.const': f64,
  'f32.const': f32,
}

export function* instr(code, args=[], exprs=[]) {
  for (let expr of exprs) {
    switch (typeof expr) {
      case 'number': yield expr; break
      default: yield* expr; break
    }
  }
  yield BYTE[code]
  for (let arg of args) {
    switch (typeof arg) {
      case 'bigint':
        yield* bigint(arg); break
      case 'number':
        yield* (encoding[code]??int)(arg); break
      default: yield* arg;
    }
  }
}

const encoder = new TextEncoder('utf-8')
export function utf8(s) {
  return [...encoder.encode(s)]
}

export function header () {
  return [...utf8('\0asm'),1,0,0,0]
}

export function section (type, data) {
  return [BYTE.section[type], ...uint(data.length), ...data]
}

export function vector (items) {
  return [...uint(items.length), ...items.flat()]
}

function locals (items) {
  const out = []
  let curr = []
  let prev

  for (const type of items) {
    if (type !== prev && curr.length) {
      out.push([...uint(curr.length), BYTE.type[curr[0]]])
      curr = []
    }
    curr.push(type)
    prev = type
  }

  if (curr.length)
    out.push([...uint(curr.length), BYTE.type[curr[0]]])

  return out
}

function limits (min, max, shared) {
  if (shared != null) {
    return [BYTE.limits.shared, ...uint(min), ...uint(max)]
  } else if (max != null) {
    return [BYTE.limits.minmax, ...uint(min), ...uint(max)]
  }
  else {
    return [BYTE.limits.min, ...uint(min)]
  }
}

section.type = function (types) {
  return section('type',
    vector(types.map(([params, results]) => [
      BYTE.type.func,
      ...vector(  params.map(x => BYTE.type[x] )),
      ...vector( results.map(x => BYTE.type[x] )),
    ])))
}

section.import = function (imported) {
  return section('import',
    vector(imported.map(([mod, field, type, desc]) => [
      ...vector(utf8(mod)),
      ...vector(utf8(field)),
      BYTE.import[type],
      ...({
        'func': () => desc.map(idx => [...uint(idx)]),
        'memory': () => limits(...desc),
       }[type]())
    ])))
}

section.function = function (funcs) {
  return section('function',
    vector(funcs.map(func =>
      [...uint(func)]
    )))
}

section.table = function (tables) {
  return section('table',
    vector(tables.map(([type, min, max]) =>
      [BYTE.type[type], ...limits(min, max)]
    )))
}

section.memory = function (memories) {
  return section('memory',
    vector(memories.map(([min, max]) =>
      limits(min, max)
    )))
}

section.global = function (globals) {
  return section('global',
    vector(globals.map(([mut, valtype, expr]) =>
      [BYTE.type[valtype], BYTE.global[mut], ...expr, BYTE.end]
    )))
}

section.export = function (exports) {
  return section('export',
    vector(exports.map(([name, type, idx]) =>
      [...vector(utf8(name)), BYTE.export[type], ...uint(idx)]
    )))
}

section.start = function (func_idx) {
  return section('start', [...uint(func_idx)])
}

section.element = function (elements) {
  return section('element',
    vector(elements.map(([table_idx, offset_idx_expr, funcs]) =>
      [...uint(table_idx), ...offset_idx_expr, BYTE.end, ...vector(funcs)]
    )))
}

section.code = function (funcs) {
  return section('code',
    vector(funcs.map(([func_locals, func_body]) =>
      vector([...vector(locals(func_locals)), ...func_body, BYTE.end])
    )))
}

section.data = function (data) {
  return section('data',
    vector(data.map(([mem_idx, offset_idx_expr, bytes]) =>
      [...uint(mem_idx), ...offset_idx_expr, BYTE.end, ...vector(bytes)]
    )))
}
