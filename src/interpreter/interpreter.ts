/* tslint:disable:max-classes-per-file */
import * as es from 'estree'
import * as constants from '../constants'
import * as errors from '../errors/errors'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import { Context, Environment, Frame, Value } from '../types'
import {
  evaluateBinaryExpression,
  evaluateLogicalExpression,
  evaluateUnaryExpression
} from '../utils/operators'
// import { primitive } from '../utils/astCreator'
import * as rttc from '../utils/rttc'
import Closure from './closure'

const currentClass: string | null = null

class BreakValue {}

class ContinueValue {}

class ReturnValue {
  constructor(public value: Value) {}
}

class TailCallReturnValue {
  constructor(public callee: Closure, public args: Value[], public node: es.CallExpression) {}
}

class Thunk {
  public value: Value
  public isMemoized: boolean
  constructor(public exp: es.Node, public env: Environment) {
    this.isMemoized = false
    this.value = null
  }
}

function* forceIt(val: any, context: Context): Value {
  if (val instanceof Thunk) {
    if (val.isMemoized) return val.value

    pushEnvironment(context, val.env)
    const evalRes = yield* actualValue(val.exp, context)
    popEnvironment(context)
    val.value = evalRes
    val.isMemoized = true
    return evalRes
  } else return val
}

export function* actualValue(exp: es.Node, context: Context): Value {
  const evalResult = yield* evaluate(exp, context)
  const forced = yield* forceIt(evalResult, context)
  return forced
}

const createEnvironment = (
  closure: Closure,
  args: Value[],
  callExpression?: es.CallExpression
): Environment => {
  const environment: Environment = {
    name: closure.functionName,
    tail: closure.environment,
    head: {}
  }
  if (callExpression) {
    environment.callExpression = {
      ...callExpression
      // arguments: args.map(primitive)
    }
  }
  closure.node.params.forEach((param, index) => {
    const ident = param as es.Identifier
    environment.head[ident.name] = args[index]
  })
  return environment
}

const createClassEnvironment = (
  functionName: string,
  arg_ids: Value[],
  args: Value[],
  context: Context
): Environment => {
  const environment: Environment = {
    name: functionName,
    tail: currentEnvironment(context),
    head: {}
  }

  for (let i = 0; i < arg_ids.length; i++) {
    environment.head[arg_ids[i]] = args[i]
  }
  return environment
}

const createFunctionEnvironment = (
  functionName: string,
  arg_ids: Value[],
  args: Value[],
  context: Context
): Environment => {
  const environment: Environment = {
    name: functionName,
    tail: currentEnvironment(context),
    head: {}
  }

  //Debug
  // console.log("CREATE FUNC ENV")
  // console.log(arg_ids)
  // console.log(args)

  for (let i = 0; i < arg_ids.length; i++) {
    environment.head[arg_ids[i].name] = args[i]
  }
  return environment
}

const createBlockEnvironment = (
  context: Context,
  name = 'blockEnvironment',
  head: Frame = {}
): Environment => {
  return {
    name,
    tail: currentEnvironment(context),
    head
  }
}

const handleRuntimeError = (context: Context, error: RuntimeSourceError): never => {
  context.errors.push(error)
  context.runtime.environments = context.runtime.environments.slice(
    -context.numberOfOuterEnvironments
  )
  throw error
}

const DECLARED_BUT_NOT_YET_ASSIGNED = Symbol('Used to implement hoisting')

function get_type(value: any) {
  let v_type = ''
  switch (typeof value) {
    case 'number':
      if (value % 1 === 0) {
        v_type = 'Int'
      } else {
        v_type = 'Double'
      }
      break
    case 'string':
      v_type = 'String'
      break
    case 'boolean':
      v_type = 'Bool'
      break
    case 'object':
      v_type = 'Object'
      break
  }
  return v_type
}

function declareIdentifier(context: Context, name: string, node: es.Node) {
  //Debug
  console.log('[declareIdentifier] name: ' + name)
  const environment = currentEnvironment(context)
  if (environment.head.hasOwnProperty(name)) {
    const descriptors = Object.getOwnPropertyDescriptors(environment.head)

    return handleRuntimeError(
      context,
      new errors.VariableRedeclaration(node, name, descriptors[name].writable)
    )
  }
  environment.head[name] = DECLARED_BUT_NOT_YET_ASSIGNED

  //Debug
  // console.log("Declaring variables...")
  // console.log(environment)

  return environment
}

function declareVariables(context: Context, node: es.VariableDeclaration) {
  for (const declaration of node.declarations) {
    declareIdentifier(context, (declaration.id as es.Identifier).name, node)
  }
}

function declareFunctionsAndVariables(context: Context, node: es.BlockStatement) {
  //Debug
  console.log('FUNC[declareFunctionsAndVariables]')
  for (const statement of node.body) {
    switch (statement.type) {
      case 'VariableDeclaration':
        declareVariables(context, statement)
        break
      case 'FunctionDeclaration':
        declareIdentifier(context, (statement.id as es.Identifier).name, statement)
        break
      case 'ClassDeclaration':
        declareIdentifier(context, (statement.id as es.Identifier).name, statement)
        break
    }
  }
}

function assignClassVariables(context: Context, name: string, value: any, node: es.Node) {
  //Debug
  console.log('[assignClassVariables] name: ' + name)
  //Search only in the class env
  const environment = currentEnvironment(context).tail!

  if (environment.head.hasOwnProperty(name)) {
    if (typeof environment.head[name] !== 'symbol') {
      // Already have value
      let v_type = get_type(value) // Receiving Type
      let i_type = environment.head[name]['TYPE'] // Stored Type

      //Use ClassName as type
      if (i_type === 'Class') {
        i_type = environment.head[name].className
      }
      if (v_type === 'Object') {
        // assume to be Class
        v_type = value.className
      }

      //Debug
      console.log(value)
      console.log(v_type)
      console.log(environment)
      console.log(i_type)

      if (v_type !== i_type) {
        return handleRuntimeError(
          context,
          new errors.TypeAssignmentError(node, name, i_type, v_type)
        )
      }

      const i_mutable = environment.head[name]['mutable']

      if (environment.head[name].type === 'Literal') {
        // Literal variable, sometimes Type declared but no value yet
        const i_value = environment.head[name]['value']
        if (i_mutable === false && i_value !== undefined) {
          return handleRuntimeError(context, new errors.ConstAssignment(node, name))
        }
      } else {
        if (i_mutable === false) {
          return handleRuntimeError(context, new errors.ConstAssignment(node, name))
        }
      }

      environment.head[name]['value'] = value
    } else {
      // First-time initialization (DECLARED_BUT_NOT_ASSIGNED)
      environment.head[name] = value
    }
  } else {
    return handleRuntimeError(context, new errors.UndefinedVariable(name, node))
  }

  return environment
}

function assignVariables(context: Context, name: string, value: any, node: es.Node) {
  //Debug
  console.log('[assignVariables] name: ' + name)
  let environment = currentEnvironment(context)
  let classNode = null
  while (environment.tail !== null && !environment.head.hasOwnProperty(name)) {
    // Check if the variable is a property of the current class
    if (currentClass != null && environment.tail.head.hasOwnProperty(currentClass)) {
      classNode = environment.tail.head[currentClass]
    }
    environment = environment.tail
  }

  //If the variable was found in the current class, go into that class and assign the variable
  //classNode only exists if such name is not in the top environment
  if (classNode != null && currentClass != null) {
    //TODO: Update prop inside class
    // for (let i = 0; i < classNode.value.value.body.length; i++) {
    //   if (classNode.value.value.body[i].key.name == name) {
    //     classNode.value.value.body[i].value.value = value
    //     return environment
    //   }
    // }
  }

  if (environment.head.hasOwnProperty(name)) {
    if (typeof environment.head[name] !== 'symbol') {
      // Already have value
      let v_type = get_type(value) // Receiving Type
      let i_type = environment.head[name]['TYPE'] // Stored Type

      //Use ClassName as type
      if (i_type === 'Class') {
        i_type = environment.head[name].className
      }
      if (v_type === 'Object') {
        // assume to be Class
        v_type = value.className
      }

      if (v_type !== i_type) {
        return handleRuntimeError(
          context,
          new errors.TypeAssignmentError(node, name, i_type, v_type)
        )
      }

      const i_mutable = environment.head[name]['mutable']

      if (environment.head[name].type === 'Literal') {
        // Literal variable, sometimes Type declared but no value yet
        const i_value = environment.head[name]['value']
        if (i_mutable === false && i_value !== undefined) {
          return handleRuntimeError(context, new errors.ConstAssignment(node, name))
        }
      } else {
        if (i_mutable === false) {
          return handleRuntimeError(context, new errors.ConstAssignment(node, name))
        }
      }

      environment.head[name]['value'] = value
    } else {
      // First-time initialization (DECLARED_BUT_NOT_ASSIGNED)
      environment.head[name] = value
    }
  } else {
    return handleRuntimeError(context, new errors.UndefinedVariable(name, node))
  }

  return environment
}

// function findClassProperty(context: Context, name: string, node: es.Node) {
//   console.log('[findClassProperty] name: ' + name + ' currentClass: ' + currentClass)
//   let currentClassNode

//   if (currentClass != null) {
//     currentClassNode = evaluateIdentifier(context, currentClass, node)

//     const classProperties = currentClassNode.value.body

//     for (const property of classProperties) {
//       if (property.key.name === name) {
//         return property
//       }
//     }
//   }
//   return null
// }

function evaluateClassIdentifier(context: Context, name: string, node: es.Node) {
  /* Will return primitive value for primitives, return a structure for functions and classes */

  // Search only within the class env
  let environment = currentEnvironment(context)
  while (environment.tail !== null && !environment.head.hasOwnProperty('self')) {
    environment = environment.tail
  }

  if (environment.head.hasOwnProperty(name)) {
    if (typeof environment.head[name] === 'symbol') {
      return handleRuntimeError(context, new errors.UnassignedVariable(name, node))
    } else {
      if (environment.head[name]['TYPE'] == 'Function') {
        return environment.head[name]
      } else if (environment.head[name]['TYPE'] == 'Class') {
        return environment.head[name]
      } else {
        // TYPE == Int/Bool/... Primitive Values

        if (environment.head[name]['value'] === undefined) {
          return handleRuntimeError(
            context,
            new errors.UndefinedError(node, name, environment.head[name])
          )
        }
        return environment.head[name]['value']
      }
    }
  } else {
    return handleRuntimeError(context, new errors.UndefinedVariable(name, node))
  }
}

function evaluateIdentifier(context: Context, name: string, node: es.Node) {
  /* Will return primitive value for primitives, return a structure for functions and classes */
  let environment = currentEnvironment(context)
  while (environment.tail !== null && !environment.head.hasOwnProperty(name)) {
    environment = environment.tail
  }

  //Debug
  // console.log(name)
  // console.log(environment)

  if (environment.head.hasOwnProperty(name)) {
    //Debug
    // console.log(environment.head[name])

    if (typeof environment.head[name] === 'symbol') {
      return handleRuntimeError(context, new errors.UnassignedVariable(name, node))
    } else {
      if (environment.head[name]['TYPE'] == 'Function') {
        return environment.head[name]
      } else if (environment.head[name]['TYPE'] == 'Class') {
        return environment.head[name]
      } else {
        // TYPE == Int/Bool/... Primitive Values

        if (environment.head[name]['value'] === undefined) {
          return handleRuntimeError(
            context,
            new errors.UndefinedError(node, name, environment.head[name])
          )
        }
        return environment.head[name]['value']
      }
    }
  } else {
    return handleRuntimeError(context, new errors.UndefinedVariable(name, node))
  }
}

function* visit(context: Context, node: es.Node) {
  context.runtime.nodes.unshift(node)
  yield context
}

function* leave(context: Context) {
  context.runtime.nodes.shift()
  yield context
}

const currentEnvironment = (context: Context) => context.runtime.environments[0]
const replaceEnvironment = (context: Context, environment: Environment) =>
  (context.runtime.environments[0] = environment)
const popEnvironment = (context: Context) => context.runtime.environments.shift()
const pushEnvironment = (context: Context, environment: Environment) =>
  context.runtime.environments.unshift(environment)

const checkNumberOfArguments = (
  context: Context,
  callee: Closure | Value,
  args: Value[],
  exp: es.CallExpression
) => {
  if (callee instanceof Closure) {
    if (callee.node.params.length !== args.length) {
      return handleRuntimeError(
        context,
        new errors.InvalidNumberOfArguments(exp, callee.node.params.length, args.length)
      )
    }
  } else {
    if (callee.hasVarArgs === false && callee.length !== args.length) {
      return handleRuntimeError(
        context,
        new errors.InvalidNumberOfArguments(exp, callee.length, args.length)
      )
    }
  }
  return undefined
}

export type Evaluator<T extends es.Node> = (node: T, context: Context) => IterableIterator<Value>

function* evaluateBlockSatement(context: Context, node: es.BlockStatement) {
  //Debug
  console.log('[evaluateBlockSatement]')

  declareFunctionsAndVariables(context, node)

  //Debug
  // console.log("[Block] start eval statements")

  let result
  for (const statement of node.body) {
    //Debug
    // console.log("[Block] eval statement")

    result = yield* evaluate(statement, context)

    //Debug
    // console.log(result)

    if (
      result instanceof ReturnValue ||
      result instanceof TailCallReturnValue ||
      result instanceof BreakValue ||
      result instanceof ContinueValue
    ) {
      break
    }
  }
  return result
}

/**
 * WARNING: Do not use object literal shorthands, e.g.
 *   {
 *     *Literal(node: es.Literal, ...) {...},
 *     *ThisExpression(node: es.ThisExpression, ..._ {...},
 *     ...
 *   }
 * They do not minify well, raising uncaught syntax errors in production.
 * See: https://github.com/webpack/webpack/issues/7566
 */
// tslint:disable:object-literal-shorthand
// prettier-ignore
// Mapped Types
// https://www.typescriptlang.org/docs/handbook/2/mapped-types.html#handbook-content
export const evaluators: { [nodeType: string]: Evaluator<es.Node> } = {
    /** Simple Values */
    Literal: function*(node: es.Literal, context: Context) {
        return node.value
    },

    TemplateLiteral: function*(node: es.TemplateLiteral) {
        // Expressions like `${1}` are not allowed, so no processing needed
        return node.quasis[0].value.cooked
    },

    ThisExpression: function*(node: es.ThisExpression, context: Context) {
        return context.runtime.environments[0].thisContext
    },

    ArrayExpression: function*(node: es.ArrayExpression, context: Context) {
        throw new Error("Array expressions not supported in x-slang");
    },

    DebuggerStatement: function*(node: es.DebuggerStatement, context: Context) {
        yield
    },

    FunctionExpression: function*(node: es.FunctionExpression, context: Context) {
        throw new Error("Function expressions not supported in x-slang");
    },

    ArrowFunctionExpression: function*(node: es.ArrowFunctionExpression, context: Context) {
        throw new Error("Arrow functions expressions not supported in x-slang");
    },

    Identifier: function*(node: es.Identifier, context: Context) {
        //Debug
        const name = node.name
        console.log('[Identifier] name:', name)

        // if(currentEnvironment(context).head.hasOwnProperty(name)){
        //     return yield* evaluate(currentEnvironment(context).head[name], context)
        // }

        // if(currentClass != null && findClassProperty(context, name, node) != null){
        //     return yield* evaluate(findClassProperty(context, name, node), context)
        // }

        return evaluateIdentifier(context, name, node)

        // throw new Error("Variables not supported in x-slang");
    },

    CallExpression: function*(node: es.CallExpression, context: Context) {
        //Debug
        console.log("[CallExpression]")
        const callee_name = (<es.Identifier>node.callee).name
        const callee = evaluateIdentifier(context, callee_name, node)
        
        if(callee.TYPE === 'Class') {
            //Deep copy the original class obejct
            const newClassObject = Object.assign({}, callee);

            //Debug
            // console.log(callee)
            // console.log(newClassObject)

            if (newClassObject.Method.has('init')) {
              const initializer = newClassObject.Method.get('init')

              //Debug
              // console.log(initializer)

              const class_params = []
              const class_variables = []
              // Create Class Env
              class_params.push('self')
              class_variables.push(callee_name)
              for (const [key, value] of newClassObject.StorProp.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }
              for (const [key, value] of newClassObject.CompProp.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }
              for (const [key, value] of newClassObject.Method.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }

              //Debug
              // console.log("HERE")

              const class_env = createClassEnvironment(callee_name, class_params, class_variables, context)
              pushEnvironment(context, class_env)

              // Create Local Env
              const args = node.arguments
              const arg_variables = []
              for (let i = 0; i < args.length; i++) {
                const arg_value = yield* evaluate(args[i].VALUE!, context)

                //Debug
                // console.log("ARGVALUE! EVAUATED")

                const real_value = {
                  "type": "Literal",
                  "mutable": true,
                  "TYPE": get_type(arg_value),
                  "value": arg_value
                }
                arg_variables.push(real_value)
              }

              //Debug
              // console.log("HERE2")

              const env = createFunctionEnvironment('init', initializer.params, arg_variables, context)
              
              //Debug
              // console.log(env)

              pushEnvironment(context, env)
              yield* evaluate(initializer.value, context)
              popEnvironment(context)

              // Alter the original stored property
              for (const key of newClassObject.StorProp.keys()) {
                newClassObject.StorProp.set(key, class_env.head[key])
              }

              popEnvironment(context)
            }
            return newClassObject
        } else { // callee.TYPE === 'Function'
            const args = node.arguments

            const arg_variables = []
            for (let i = 0; i < args.length; i++) {
              const arg_value = yield* evaluate(args[i].VALUE!, context)
              const real_value = {
                "type": "Literal",
                "mutable": true,
                "TYPE": get_type(arg_value),
                "value": arg_value
              }
              arg_variables.push(real_value)
            }

            const env = createFunctionEnvironment(callee_name, callee.params, arg_variables, context)
            pushEnvironment(context, env)

            let result = yield* evaluate(callee.value, context)
            popEnvironment(context)

            if (result instanceof ReturnValue) {
              result = result.value
            } else {
              result = null
            }

            return result
        }
    },

    NewExpression: function*(node: es.NewExpression, context: Context) {
        const callee = yield* evaluate(node.callee, context)
        const args = []
        for (const arg of node.arguments) {
            args.push(yield* evaluate(arg, context))
        }
        const obj: Value = {}
        if (callee instanceof Closure) {
            obj.__proto__ = callee.fun.prototype
            callee.fun.apply(obj, args)
        } else {
            obj.__proto__ = callee.prototype
            callee.apply(obj, args)
        }
        return obj
    },

    UnaryExpression: function*(node: es.UnaryExpression, context: Context) {
        const value = yield* actualValue(node.argument, context)

        const error = rttc.checkUnaryExpression(node, node.operator, value)
        if (error) {
            return handleRuntimeError(context, error)
        }
        return evaluateUnaryExpression(node.operator, value)
    },

    BinaryExpression: function*(node: es.BinaryExpression, context: Context) {
        const left = yield* actualValue(node.left, context)
        const right = yield* actualValue(node.right, context)
        const error = rttc.checkBinaryExpression(node, node.operator, left, right)
        if (error) {
            return handleRuntimeError(context, error)
        }
        return evaluateBinaryExpression(node.operator, left, right)
    },

    ConditionalExpression: function*(node: es.ConditionalExpression, context: Context) {
        throw new Error("Conditional expressions not supported in x-slang");
    },

    LogicalExpression: function*(node: es.LogicalExpression, context: Context) {
        const left = yield* actualValue(node.left, context)
        const right = yield* actualValue(node.right, context)
        //TODO make check work with logical expressions
        /*
        const error = rttc.checkBinaryExpression(node, node.operator, left, right)
        if (error) {
            return handleRuntimeError(context, error)
        }
         */
        return evaluateLogicalExpression(node.operator, left, right)
    },

    VariableDeclaration: function*(node: es.VariableDeclaration, context: Context) {
        //Debug
        console.log("[VariableDeclaration]")

        const kind = node.kind
        let mutable = true
        switch (kind) {
          case "let":
            mutable = false
            break
          case "var":
            mutable = true
            break
        } 

        for (const declaration of node.declarations) {
          const name = (<es.Identifier>declaration.id).name
          let value = declaration.init
          let type = declaration.TYPE

          if (value !== undefined) {
            value = yield* evaluate(<es.Expression>value, context)
            type = get_type(value)
          }

          const real_value = {
            "type": "Literal",
            "mutable": mutable,
            "TYPE": type,
            "value": value
          }

          //Debug
          // console.log("REAL_VALUE")
          // console.log(real_value)

          assignVariables(context, name, real_value, node)
        }

        return null;
        // throw new Error("Variable declarations not supported in x-slang");
    },

    ContinueStatement: function*(node: es.ContinueStatement, context: Context) {
        throw new Error("Continue statements not supported in x-slang");
    },

    BreakStatement: function*(node: es.BreakStatement, context: Context) {
        throw new Error("Break statements not supported in x-slang");
    },

    ForStatement: function*(node: es.ForStatement, context: Context) {
        // Create a new block scope for the loop variables
        throw new Error("For statements not supported in x-slang");
    },

    MemberExpression: function*(node: es.MemberExpression, context: Context) {
        //Debug
        console.log("[MemberExpression]")
        const object_name = (<es.Identifier>node.object).name;
        let object = undefined
        if (object_name === 'self') { // self call
          if (node.property.type === 'Identifier') {
            const property_name = (<es.Identifier>node.property).name
            const value = evaluateClassIdentifier(context, property_name, node)

            return value

          } else if (node.property.type === 'CallExpression'){
            const property_name = (<es.Identifier>node.property.callee).name
            const method = evaluateClassIdentifier(context, property_name, node)
            
            // Create Local Env
            const args = node.property.arguments
            const arg_variables = []
            for (let i = 0; i < args.length; i++) {
              const arg_value = yield* evaluate(args[i].VALUE!, context)

              //Debug
              // console.log("ARGVALUE! EVAUATED")

              const real_value = {
                "type": "Literal",
                "mutable": true,
                "TYPE": get_type(arg_value),
                "value": arg_value
              }
              arg_variables.push(real_value)
            }

            //Debug
            // console.log("HERE2")

            const env = createFunctionEnvironment(property_name, method.params, arg_variables, context)


            pushEnvironment(context, env)
            let result = yield* evaluate(method.value, context)
            popEnvironment(context)

            if (result instanceof ReturnValue) {
              result = result.value
            } else {
              result = null
            }

            return result
            
          }
          
        } else {
          object = yield* evaluate(node.object, context); 

          if (node.property.type === 'Identifier') { // Find Prop
            const property_name = (<es.Identifier>node.property).name

            if (object.StorProp.has(property_name)) { // This is a stored property
              return object.StorProp.get(property_name).value
            } else if (object.CompProp.has(property_name)) { // This is a computed property
              const prop = object.CompProp.get(property_name)
              if (prop.Get === null) {
                return handleRuntimeError(context, new errors.RunMissingGetterError(node, property_name))
              }
              const getter = prop.Get

              const class_params = []
              const class_variables = []
              // Create Class Env
              class_params.push('self')
              class_variables.push(object_name)
              for (const [key, value] of object.StorProp.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }
              for (const [key, value] of object.CompProp.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }
              for (const [key, value] of object.Method.entries()) {
                class_params.push(key)
                class_variables.push(value)
              }

              //Debug
              // console.log("HERE")

              const class_env = createClassEnvironment(object_name, class_params, class_variables, context)
              pushEnvironment(context, class_env)

              // Create Local Env

              //Debug
              // console.log("HERE2")

              const env = createFunctionEnvironment(property_name, getter.params, [], context)
              
              //Debug
              // console.log(env)

              pushEnvironment(context, env)
              let result = yield* evaluate(getter.value, context)
              popEnvironment(context)

              // Alter the original stored property
              for (const key of object.StorProp.keys()) {
                object.StorProp.set(key, class_env.head[key])
              }

              popEnvironment(context)

              if (result instanceof ReturnValue) {
                result = result.value
              } else {
                result = null
              }

              return result
            } else {
            }

          } else if (node.property.type === 'CallExpression'){  // Find Method
            const property_name = (<es.Identifier>node.property.callee).name
            const method = object.Method.get(property_name)

            //Debug
            // console.log(initializer)

            const class_params = []
            const class_variables = []
            // Create Class Env
            class_params.push('self')
            class_variables.push(object_name)
            for (const [key, value] of object.StorProp.entries()) {
              class_params.push(key)
              class_variables.push(value)
            }
            for (const [key, value] of object.CompProp.entries()) {
              class_params.push(key)
              class_variables.push(value)
            }
            for (const [key, value] of object.Method.entries()) {
              class_params.push(key)
              class_variables.push(value)
            }

            //Debug
            // console.log("HERE")

            const class_env = createClassEnvironment(object_name, class_params, class_variables, context)
            pushEnvironment(context, class_env)

            // Create Local Env
            const args = node.property.arguments
            const arg_variables = []
            for (let i = 0; i < args.length; i++) {
              const arg_value = yield* evaluate(args[i].VALUE!, context)

              //Debug
              // console.log("ARGVALUE! EVAUATED")

              const real_value = {
                "type": "Literal",
                "mutable": true,
                "TYPE": get_type(arg_value),
                "value": arg_value
              }
              arg_variables.push(real_value)
            }

            //Debug
            // console.log("HERE2")

            const env = createFunctionEnvironment(property_name, method.params, arg_variables, context)


            pushEnvironment(context, env)
            let result = yield* evaluate(method.value, context)
            popEnvironment(context)

            // Alter the original stored property
            for (const key of object.StorProp.keys()) {
              object.StorProp.set(key, class_env.head[key])
            }

            popEnvironment(context)

            if (result instanceof ReturnValue) {
              result = result.value
            } else {
              result = null
            }

            return result
          }

          // currentClass = oldClass
        }
        
        // let property = null
        // for (let i = 0; i < properties.length; i++) {
        //     if (properties[i].key.name == property_name) {
        //         property = properties[i]
        //     }
        // }

        // if (property !== null) {
        //     if(property.type == 'CompPropDeclaration') {
        //         let getter
        //         if((<es.Identifier>property.body.body[0].id).name == 'get') {
        //             getter = property.body.body[0]
        //         } else {
        //             getter = property.body.body[1]
        //         }
        //         const env = createFunctionEnvironment('get', [], [], context)
        //         pushEnvironment(context, env)

        //         const result = yield* evaluate(getter.body, context)

        //         popEnvironment(context)

        //         if (result instanceof ReturnValue) {
        //             return result.value
        //         }
        //     } else if (property.type == 'PropertyDefinition') {
        //         return yield* evaluate(property, context);
        //     }
        // }
        return null
    },

    PropertyDefinition: function*(node: es.PropertyDefinition, context: Context) {
        console.log("[PropertyDefinition]")
        if (node.value) {
          const result = yield* evaluate(node.value, context);
          return result
        } else { //TODO: Property Type Definition
          return null
        }
    },

    AssignmentExpression: function*(node: es.AssignmentExpression, context: Context) {
        //Debug
        console.log("[AssignmentExpression]")

        const value = yield* evaluate(node.right, context)

        //Debug
        // console.log(value)

        if (node.left.type === "MemberExpression") {
            const object_name = (<es.Identifier>node.left.object).name
            const property_name = (<es.Identifier>node.left.property).name

            if (object_name === 'self') {
              assignClassVariables(context, property_name, value, node)
            } else {
              const obj = yield* evaluate(node.left.object, context)

              //Debug
              // console.log(obj)

              if (obj.StorProp.has(property_name)) { // This is a stored property
                const prop = obj.StorProp.get(property_name)
                if (prop.mutable === false) {
                  return handleRuntimeError(context, new errors.ConstAssignment(node, property_name))
                } else {
                  prop.value = value
                }
              } else if (obj.CompProp.has(property_name)) { // This is a computed property
                
                const prop = obj.CompProp.get(property_name)
                if (prop.Set === null) {
                  return handleRuntimeError(context, new errors.RunMissingSetterError(node, property_name))
                }

                const setter = prop.Set

                const class_params = []
                const class_variables = []
                // Create Class Env
                class_params.push('self')
                class_variables.push(object_name)
                for (const [key, value] of obj.StorProp.entries()) {
                  class_params.push(key)
                  class_variables.push(value)
                }
                for (const [key, value] of obj.CompProp.entries()) {
                  class_params.push(key)
                  class_variables.push(value)
                }
                for (const [key, value] of obj.Method.entries()) {
                  class_params.push(key)
                  class_variables.push(value)
                }

                //Debug
                // console.log("HERE")

                const class_env = createClassEnvironment(object_name, class_params, class_variables, context)
                pushEnvironment(context, class_env)

                // Create Local Env
                const arg_variables = []
                
                const arg_value = value

                const real_value = {
                  "type": "Literal",
                  "mutable": true,
                  "TYPE": get_type(arg_value),
                  "value": arg_value
                }
                arg_variables.push(real_value)

                //Debug
                // console.log("HERE2")

                const env = createFunctionEnvironment(property_name, setter.params, arg_variables, context)
                
                //Debug
                // console.log(env)

                pushEnvironment(context, env)
                yield* evaluate(setter.value, context)
                popEnvironment(context)

                // Alter the original stored property
                for (const key of obj.StorProp.keys()) {
                  obj.StorProp.set(key, class_env.head[key])
                }

                popEnvironment(context)

              } else {
              }

              //Debug
              // console.log(obj)
            }
            
            // for (let i = 0; i < object_body.length; i++) {
            //     if (object_body[i].key.name == property_name) {
            //         property_to_assign = objectNode.value.body[i]
            //     }
            // }

            // if (property_to_assign != null) {
            //     if (property_to_assign.type == 'CompPropDeclaration') {
                    //HANDLE COMPUTED PROPERTY HERE
                    /*
                    console.log("[type == 'CompPropDeclaration]", property_to_assign)
                    console.log("ENV1", currentEnvironment(context))
                    const env = createFunctionEnvironment('set', ['a'], [value], context)
                    pushEnvironment(context, env)
                    console.log("ENV2", currentEnvironment(context))

                    const result = yield* evaluate(property_to_assign, context)
                    console.log("RESULT", result)
                    console.log("ENV3", currentEnvironment(context))

                    popEnvironment(context)
                    
                     */
            //     } else if (property_to_assign.type == 'PropertyDefinition') {
            //         property_to_assign.value.value = value
            //     }
            // }

        } else {
            const name = (<es.Identifier>node.left).name
            assignVariables(context, name, value, node)
        }
        return null;
    },

    FunctionDeclaration: function*(node: es.FunctionDeclaration, context: Context) {
        //Debug
        const name = (<es.Identifier>node.id).name
        console.log("[FunctionDeclaration], name:", name)

        const real_value = {
          "type": "BlockStatement",
          "mutable": false,
          "TYPE": "Function",
          "params": node.params,
          "value": node.body
        }

        assignVariables(context, name, real_value, node);

        return null;
        // throw new Error("Function declarations not supported in x-slang");
    },

    CompPropDeclaration: function*(node: es.CompPropDeclaration, context: Context) {
        console.log("[CompPropDeclaration]")
        const result = yield* evaluate(node.body, context);
        return result
    },

    ClassDeclaration: function*(node: es.ClassDeclaration, context: Context) {
        console.log("[ClassDeclaration]")
        const name = (<es.Identifier>node.id).name
        const real_value = {
            type: "ClassBody",
            TYPE: "Class",
            className: name,
            mutable: true,
            StorProp: new Map(),
            CompProp: new Map(),
            Method: new Map()
            // "superClass": node.superClass
        }

        for (let i = 0; i < node.body.body.length; i++) {
          const Prop = node.body.body[i]
          switch(Prop.type) {
            case "PropertyDefinition": {
              const mutable = (Prop.kind == 'var' ? true : false)
              let value = Prop.value
              let type = Prop.TYPE

              if (Prop.TYPE === undefined) { // Value declaration
                value = yield* evaluate(Prop.value!, context)
                type = get_type(value)
              }

              const sub_real_value = {
                "type": "Literal",
                "mutable": mutable,
                "TYPE": type,
                "value": value
              }
              real_value.StorProp.set(Prop.key.name, sub_real_value)
              break
            }
            case "CompPropDeclaration": {
              const mutable = false
              const type = Prop.TYPE

              const sub_real_value = {
                "type": "CompProp",
                "mutable": mutable,
                "TYPE": type,
                "Get": null as any,
                "Set": null as any
              }

              for (let i = 0; i < Prop.body.body.length; i++) {
                const GSF = Prop.body.body[i] // FunctionDeclaration for getter or setter
                if (GSF.type === 'FunctionDeclaration') {
                  const function_value = {
                    "type": "BlockStatement",
                    "mutable": false,
                    "TYPE": "Function",
                    "params": GSF.params,
                    "value": GSF.body
                  }
                  switch (GSF.id!.name) {
                    case 'get': {
                      sub_real_value.Get = function_value
                      break
                    }
                    case 'set': {
                      sub_real_value.Set = function_value
                      break
                    }
                  }
                }
              }
              real_value.CompProp.set(Prop.key.name, sub_real_value)
              break
            }
            case "MethodDefinition": {
              const mutable = false

              const sub_real_value = {
                "type": "BlockStatement",
                "mutable": mutable,
                "TYPE": "Function",
                "params": Prop.params,
                "value": Prop.value
              }

              real_value.Method.set(Prop.key.name, sub_real_value)
              break
            }
          }
        }

        assignVariables(context, name, real_value, node);

        //Debug
        console.log(real_value)

        return null;
    },

    ProtocolDeclaration: function*(node: es.ProtocolDeclaration, context: Context) {
        console.log("[ProtocolDeclaration]")
        return null;
    },

    IfStatement: function*(node: es.IfStatement | es.ConditionalExpression, context: Context) {
        const test = yield* actualValue(node.test, context)
        let result;
        if (test == true ) {
            result = yield* evaluate(node.consequent, context);
        } else if (node.alternate != null) {
            result = yield* evaluate(node.alternate, context);
        } else {
            result = null
        }
        return result;
    },

    ExpressionStatement: function*(node: es.ExpressionStatement, context: Context) {
        console.log("[ExpressionStatement]")
        return yield* evaluate(node.expression, context)
    },

    ReturnStatement: function*(node: es.ReturnStatement, context: Context) {
        console.log("[ReturnStatement]")
        const result = yield* evaluate(<es.Expression>node.argument, context)
        return new ReturnValue(result)
        // throw new Error("Return statements not supported in x-slang");
    },

    WhileStatement: function*(node: es.WhileStatement, context: Context) {
        throw new Error("While statements not supported in x-slang");
    },

    ObjectExpression: function*(node: es.ObjectExpression, context: Context) {
        throw new Error("Object expressions not supported in x-slang");
    },

    BlockStatement: function*(node: es.BlockStatement, context: Context) {
        //Debug
        console.log("[BlockStatement]")
        console.log("HERE")

        const result = yield* evaluateBlockSatement(context, node)
        return result
    },

    ImportDeclaration: function*(node: es.ImportDeclaration, context: Context) {
        throw new Error("Import declarations not supported in x-slang");
    },

    Program: function*(node: es.BlockStatement, context: Context) {
        //Debug
        // console.log("[Program] Eval Program...")

        context.numberOfOuterEnvironments += 1
        const environment = createBlockEnvironment(context, 'programEnvironment')
        pushEnvironment(context, environment)

        //Debug
        // console.log("[Program] Start eval block")

        const result = yield* forceIt(yield* evaluateBlockSatement(context, node), context);

        //Debug
        // console.log("[Program] Program finished.")

        return result;
    },

    EmptyStatement: function*(node: es.EmptyStatement, context: Context) {
        return null;
    }
}
// tslint:enable:object-literal-shorthand

export function* evaluate(node: es.Node, context: Context) {
  //Debug
  // console.log('Evaluating...')
  // console.log(node)
  // console.log('>>>>>>>>>>')

  yield* visit(context, node)
  const result = yield* evaluators[node.type](node, context)
  yield* leave(context)
  return result
}

export function* apply(
  context: Context,
  fun: Closure | Value,
  args: (Thunk | Value)[],
  node: es.CallExpression,
  thisContext?: Value
) {
  let result: Value
  let total = 0

  while (!(result instanceof ReturnValue)) {
    if (fun instanceof Closure) {
      checkNumberOfArguments(context, fun, args, node!)
      const environment = createEnvironment(fun, args, node)
      if (result instanceof TailCallReturnValue) {
        replaceEnvironment(context, environment)
      } else {
        pushEnvironment(context, environment)
        total++
      }
      const bodyEnvironment = createBlockEnvironment(context, 'functionBodyEnvironment')
      bodyEnvironment.thisContext = thisContext
      pushEnvironment(context, bodyEnvironment)
      result = yield* evaluateBlockSatement(context, fun.node.body as es.BlockStatement)
      popEnvironment(context)
      if (result instanceof TailCallReturnValue) {
        fun = result.callee
        node = result.node
        args = result.args
      } else if (!(result instanceof ReturnValue)) {
        // No Return Value, set it as undefined
        result = new ReturnValue(undefined)
      }
    } else if (typeof fun === 'function') {
      checkNumberOfArguments(context, fun, args, node!)
      try {
        const forcedArgs = []

        for (const arg of args) {
          forcedArgs.push(yield* forceIt(arg, context))
        }

        result = fun.apply(thisContext, forcedArgs)
        break
      } catch (e) {
        // Recover from exception
        context.runtime.environments = context.runtime.environments.slice(
          -context.numberOfOuterEnvironments
        )

        const loc = node ? node.loc! : constants.UNKNOWN_LOCATION
        if (!(e instanceof RuntimeSourceError || e instanceof errors.ExceptionError)) {
          // The error could've arisen when the builtin called a source function which errored.
          // If the cause was a source error, we don't want to include the error.
          // However if the error came from the builtin itself, we need to handle it.
          return handleRuntimeError(context, new errors.ExceptionError(e, loc))
        }
        result = undefined
        throw e
      }
    } else {
      return handleRuntimeError(context, new errors.CallingNonFunctionValue(fun, node))
    }
  }
  // Unwraps return value and release stack environment
  if (result instanceof ReturnValue) {
    result = result.value
  }
  for (let i = 1; i <= total; i++) {
    popEnvironment(context)
  }
  return result
}
