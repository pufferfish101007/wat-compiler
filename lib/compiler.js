import ModuleBuilder from './builder.js'
import { uint, bigint, hex2float, nanbox32, nanbox64 } from './leb128.js'
import { INSTR, ALIGN } from './const.js'

// eslint-disable-next-line no-unused-vars
const print = x => console.log(JSON.stringify(x, null, 2))

class GlobalContext {
  globals = []
  types = []
  funcs = []

  constructor(data) {
    if (data) Object.assign(this, data)
  }

  lookup (name, instr) {
    let index

    switch (instr) {
      case 'call': {
        index = this.funcs.map(x => x.name).lastIndexOf(name)
      }
      break

      case 'type': {
        index = this.types.map(x => x.name).lastIndexOf(name)
      }
      break

      default: {
        index = this.globals.map(x => x.name).lastIndexOf(name)
      }
    }

    return uint(index)
  }
}

export default function compile (node, moduleData, globalData) {
  const m = new ModuleBuilder(moduleData)
  const g = new GlobalContext(globalData)
  const deferred = []

  function cast (param, context=g, instr='i32') {
    switch (param.kind) {
      case 'number': {
        if (param.value === 'inf' || param.value === '+inf') {
          return Infinity
        }
        else if (param.value === '-inf') {
          return -Infinity
        }
        else if (param.value === 'nan' || param.value === '+nan') {
          return NaN
        }
        else if (param.value === '-nan') {
          return -NaN
        }
        else if (instr?.[0] === 'f') {
          return parseFloat(param.value)
        }
      }
      case 'hex': {
        let value
        if (instr.indexOf('i64') === 0) {
          if (param.value[0] === '-') {
            value = -BigInt(param.value.slice(1))
          }
          else {
            value = BigInt(param.value)
          }
          return value
        }
        else if (instr[0] === 'f') {
          if (param.value.indexOf('nan') >= 0) {
            if (instr.indexOf('f32') === 0) {
              value = nanbox32(param.value)
            }
            else { // f64
              value = nanbox64(param.value)
            }
          }
          else {
            value = hex2float(param.value)
          }
          return value
        }
        else {
          return parseInt(param.value)
        }
      }
      case 'label': return context.lookup(param.value, instr)
      default: return param.value
    }
  }

  class FunctionContext {
    locals = []
    depth = []

    lookup (name, instr) {
      let index

      switch (instr) {
        case 'br':
        case 'br_table':
        case 'br_if': {
          index = this.depth.lastIndexOf(name)
          if (~index) index = this.depth.length - 1 - index
        }
        break

        default: {
          index = this.locals.lastIndexOf(name)
        }
      }

      if (!~index) return g.lookup(name, instr)

      return uint(index)
    }
  }

  function bytes (instr, args, expr) {
    if (!(instr in INSTR) || (typeof INSTR[instr] !== 'function')) {
      throw new Error('Unknown instruction: ' + instr)
    }
    return [...INSTR[instr](args, expr)]
  }

  function evaluate (node, context = g) {
    const address = { offset: 0, align: 0 }
    const instr = node.instr.value
    switch (instr) {
      case 'type': {
        return m.getType(node.name.value)
      }

      case 'call_indirect': {
        const args = [evaluate(node.children.shift(), context), 0] // 0 is implicit table index 0
        const expr = node.children.flatMap(x => evaluate(x, context))
        return bytes(instr, args, expr)
      }

      case 'memory.grow': {
        const args = [0] // TODO: this bit is reserved?
        const expr = node.children.flatMap(x => evaluate(x, context))
        return bytes(instr, args, expr)
      }

      case 'i32.load':
      case 'i64.load':
      case 'f32.load':
      case 'f64.load':

      case 'i32.load8_s':
      case 'i32.load8_u':
      case 'i32.load16_s':
      case 'i32.load16_u':

      case 'i64.load8_s':
      case 'i64.load8_u':
      case 'i64.load16_s':
      case 'i64.load16_u':
      case 'i64.load32_s':
      case 'i64.load32_u':

      case 'i32.store':
      case 'i64.store':
      case 'f32.store':
      case 'f64.store':

      case 'i32.store8':
      case 'i32.store16':
      case 'i64.store8':
      case 'i64.store16':
      case 'i64.store32':

      {
        address.align = ALIGN[instr]
        for (const p of node.params) {
          address[p.param.value] = cast(p.value)
        }
        const args = [Math.log2(address.align), address.offset].map(x => {
          if (typeof x === 'number') return uint(x)
          else if (typeof x === 'bigint') return bigint(x)
        })
        const expr = node.children.flatMap(x => evaluate(x, context))
        return bytes(instr, args, expr)
      }

      case 'func': {
        const func = {
          name: node.name?.value ?? g.funcs.length,
          params: [],
          results: [],
        }

        g.funcs.push(func)

        for (const c of node.children) {
          switch (c.instr.value) {
            case 'param': {
              func.params.push(...c.children.map(x => x.instr.value))
            }
            break

            case 'result': {
              func.results.push(...c.children.map(x => x.instr.value))
            }
            break
          }
        }

        return [func.name, func.params, func.results]
      }

      case 'result': {
        return node.children.flatMap(x => INSTR.type[x.instr.value]())
      }

      case 'else':
      case 'then': {
        return node.children.flatMap(x => evaluate(x, context))
      }

      case 'if': {
        const name = node.name?.value ?? context.depth.length
        const results = []
        const branches = []
        let cond

        context.depth.push(name)

        for (const c of node.children) {
          switch (c.instr.value) {
            case 'result': {
              results.push(evaluate(c, context))
            }
            break

            case 'else':
              branches.push(...INSTR.else())
            case 'then': {
              branches.push(evaluate(c, context))
            }
            break

            default: {
              cond = evaluate(c, context)
            }
          }
        }

        context.depth.pop()

        if (!results.length) {
          results.push(INSTR.type.void())
        }

        // TODO: m.if(['i32'], cond, then, else)
        return [
          ...INSTR.if(results.flat(), cond),
          ...branches.flat(),
          ...INSTR.end()
        ]
      }

      case 'loop':
      case 'block': {
        const name = node.name?.value ?? context.depth.length
        const results = []
        const body = []

        context.depth.push(name)

        for (const c of node.children) {
          switch (c.instr.value) {
            case 'result': {
              results.push(evaluate(c, context))
            }
            break

            default: {
              body.push(evaluate(c, context))
            }
          }
        }

        context.depth.pop()

        if (!results.length) {
          results.push(INSTR.type.void())
        }

        // TODO: m.block(name, ['i32'], body)
        return [
          ...INSTR[instr](),
          ...results.flat().map(x => [...x]),
          ...body.flat(),
          ...INSTR.end()
        ]
      }

      case 'br_table': {
        if (node.name) {
          node.params.unshift({
            param: {
              value: context.lookup(node.name.value, instr)
            }
          })
        }
        const args = node.params.map(x => cast(x.param, context, instr))
        const expr = node.children.flatMap(x => evaluate(x, context))
        return bytes(instr, [args.length-1, ...args], expr)
      }

      default: {
        if (node.name) {
          node.params.unshift({
            param: {
              value: (instr.startsWith('global') ? g : context)
                .lookup(node.name.value, instr)
            }
          })
        }
        const args = node.params.map(x => cast(x.param, context, instr))
        const expr = node.children.flatMap(x => evaluate(x, context))
        return bytes(instr, args, expr)
      }
    }
  }

  function build (node) {
    switch (node.instr.value) {
      case 'module': {
        node.children.forEach(x => build(x))
      }
      break

      case 'memory': {
        const name = node.name?.value ?? m.memories.length
        const args = node.params.map(x => cast(x.param)).flat()

        if (node.children?.[0]?.instr.value === 'export') {
          const export_name = node.children[0].params[0].param.value
          const internal_name = node.children[0].name?.value ?? 0
          m.export('memory', internal_name, export_name)
        }

        m.memory(name, ...args)
      }
      break

      case 'data': {
        const expr = node.children.shift()
        const data = node.children.shift().data
        m.data(evaluate(expr), data)
      }
      break

      case 'start': {
        m.start(node.name.value)
      }
      break

      case 'table': {
        const args = node.params.map(x => cast(x.param))
        args.unshift(args.pop())
        m.table(...args)
      }
      break

      case 'elem': {
        const expr = node.children.shift()
        const refs = node.children.map(x => x.ref.value)
        m.elem(evaluate(expr), refs)
      }
      break

      case 'import': {
        if (node.children[0].instr.value === 'func') {
          const args = node.params.map(x => cast(x.param))
          const func = evaluate(node.children[0])
          const name = func.shift()
          m.import('func', name, ...args, ...func)
        } else if (node.children[0].instr.value === 'memory') {
          const memory = node.children[0]
          const args = node.params.map(x => cast(x.param))
          const name = memory.instr.name
          const desc = memory.params.map(x => cast(x.param))
          m.import('memory', name, ...args, desc)
        }
      }
      break

      case 'global': {
        const glob = {
          name: node.name?.value ?? m.globals.length,
          vartype: 'const',
          type: node.children[0].instr.value
        }

        g.globals.push(glob)

        if (glob.type === 'mut') {
          glob.vartype = 'var'
          glob.type = node.children[0].children[0].instr.value
        }

        const expr = node.children[1]

        m.global(
          glob.name,
          glob.vartype,
          glob.type,
          evaluate(expr)
        )
      }
      break

      case 'type': {
        const type = {
          name: node.name?.value ?? m.types.length,
          params: [],
          results: []
        }

        g.types.push(type)

        for (const c of node.children[0].children) {
          switch (c.instr.value) {
            case 'param': {
              type.params.push(...c.children.map(x => x.instr.value))
            }
            break

            case 'result': {
              type.results.push(...c.children.map(x => x.instr.value))
            }
            break
          }
        }

        m.type(
          type.name,
          type.params,
          type.results
        )
      }
      break

      case 'export': {
        const exp = {
          name: node.params[0].param.value
        }
        exp.type = node.children[0].instr.value
        exp.internal_name = node.children[0].name.value
        m.export(
          exp.type,
          exp.internal_name,
          exp.name
        )
      }
      break

      case 'func': {
        const func = {
          name: node.name?.value ?? g.funcs.length,
          context: new FunctionContext(),
          params: [],
          results: [],
          locals: [],
          body: []
        }

        g.funcs.push(func)

        for (const c of node.children) {
          switch (c.instr.value) {
            case 'export': {
              const export_name = c.params[0].param.value
              m.export('func', func.name, export_name)
            }
            break

            case 'local': {
              func.locals.push(...c.children.map(x => x.instr.value))
              func.context.locals.push(...c.children.map(() => c.name?.value))
            }
            break

            case 'param': {
              func.params.push(...c.children.map(x => x.instr.value))
              func.context.locals.push(...c.children.map(() => c.name?.value))
            }
            break

            case 'result': {
              func.results.push(...c.children.map(x => x.instr.value))
            }
            break

            default: {
              func.body.push(c)
            }
          }
        }

        // function bodies are deferred evaluation
        // because we need to have all their names
        // in context first because they are called
        // from within other functions so we can't
        // know in advance
        deferred.push(() => {
          m.func(
            func.name,
            func.params,
            func.results,
            func.locals,
            [...func.body.flatMap(x => evaluate(x, func.context))]
          )
        })
      }
      break

    }
  }

  build(node)

  deferred.forEach(fn => fn())

  return { module: m, global: g }
}
