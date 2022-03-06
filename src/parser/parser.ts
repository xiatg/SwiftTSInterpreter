/* tslint:disable:max-classes-per-file */
import * as es from 'estree'
import { Context, ErrorSeverity, ErrorType, SourceError } from '../types'
import { stripIndent } from '../utils/formatters'
import { ANTLRInputStream, CommonTokenStream } from 'antlr4ts'
import { CalcLexer } from '../lang/CalcLexer'
import {
  AdditionContext,
  CalcParser,
  DivisionContext,
  ExprContext,
  ExprStatContext,
  EmptStatContext,
  MultiplicationContext,
  NumberContext,
  ParenthesesContext,
  PowerContext,
  ProgContext,
  StatContext,
  SubtractionContext
} from '../lang/CalcParser'
import { CalcVisitor } from '../lang/CalcVisitor'
import { ErrorNode } from 'antlr4ts/tree/ErrorNode'
import { ParseTree } from 'antlr4ts/tree/ParseTree'
import { RuleNode } from 'antlr4ts/tree/RuleNode'
import { TerminalNode } from 'antlr4ts/tree/TerminalNode'

export class DisallowedConstructError implements SourceError {
  public type = ErrorType.SYNTAX
  public severity = ErrorSeverity.ERROR
  public nodeType: string

  constructor(public node: es.Node) {
    this.nodeType = this.formatNodeType(this.node.type)
  }

  get location() {
    return this.node.loc!
  }

  public explain() {
    return `${this.nodeType} are not allowed`
  }

  public elaborate() {
    return stripIndent`
      You are trying to use ${this.nodeType}, which is not allowed (yet).
    `
  }

  /**
   * Converts estree node.type into english
   * e.g. ThisExpression -> 'this' expressions
   *      Property -> Properties
   *      EmptyStatement -> Empty Statements
   */
  private formatNodeType(nodeType: string) {
    switch (nodeType) {
      case 'ThisExpression':
        return "'this' expressions"
      case 'Property':
        return 'Properties'
      default: {
        const words = nodeType.split(/(?=[A-Z])/)
        return words.map((word, i) => (i === 0 ? word : word.toLowerCase())).join(' ') + 's'
      }
    }
  }
}

export class FatalSyntaxError implements SourceError {
  public type = ErrorType.SYNTAX
  public severity = ErrorSeverity.ERROR
  public constructor(public location: es.SourceLocation, public message: string) {}

  public explain() {
    return this.message
  }

  public elaborate() {
    return 'There is a syntax error in your program'
  }
}

export class MissingSemicolonError implements SourceError {
  public type = ErrorType.SYNTAX
  public severity = ErrorSeverity.ERROR
  public constructor(public location: es.SourceLocation) {}

  public explain() {
    return 'Missing semicolon at the end of statement'
  }

  public elaborate() {
    return 'Every statement must be terminated by a semicolon.'
  }
}

export class TrailingCommaError implements SourceError {
  public type: ErrorType.SYNTAX
  public severity: ErrorSeverity.WARNING
  public constructor(public location: es.SourceLocation) {}

  public explain() {
    return 'Trailing comma'
  }

  public elaborate() {
    return 'Please remove the trailing comma'
  }
}

function contextToLocation(ctx: ExprContext): es.SourceLocation {
  return {
    start: {
      line: ctx.start.line,
      column: ctx.start.charPositionInLine
    },
    end: {
      line: ctx.stop ? ctx.stop.line : ctx.start.line,
      column: ctx.stop ? ctx.stop.charPositionInLine : ctx.start.charPositionInLine
    }
  }
}
class ExpressionGenerator implements CalcVisitor<es.Expression> {
  visitNumber(ctx: NumberContext): es.Expression {
    return {
      type: 'Literal',
      value: parseInt(ctx.text),
      raw: ctx.text,
      loc: contextToLocation(ctx)
    }
  }
  visitParentheses(ctx: ParenthesesContext): es.Expression {
    return this.visit(ctx.expr())
  }
  visitPower(ctx: PowerContext): es.Expression {
    return {
      type: 'BinaryExpression',
      operator: '^',
      left: this.visit(ctx._left),
      right: this.visit(ctx._right),
      loc: contextToLocation(ctx)
    }
  }

  visitMultiplication(ctx: MultiplicationContext): es.Expression {
    return {
      type: 'BinaryExpression',
      operator: '*',
      left: this.visit(ctx._left),
      right: this.visit(ctx._right),
      loc: contextToLocation(ctx)
    }
  }
  visitDivision(ctx: DivisionContext): es.Expression {
    return {
      type: 'BinaryExpression',
      operator: '/',
      left: this.visit(ctx._left),
      right: this.visit(ctx._right),
      loc: contextToLocation(ctx)
    }
  }
  visitAddition(ctx: AdditionContext): es.Expression {
    return {
      type: 'BinaryExpression',
      operator: '+',
      left: this.visit(ctx._left),
      right: this.visit(ctx._right),
      loc: contextToLocation(ctx)
    }
  }

  visitSubtraction(ctx: SubtractionContext): es.Expression {
    return {
      type: 'BinaryExpression',
      operator: '-',
      left: this.visit(ctx._left),
      right: this.visit(ctx._right),
      loc: contextToLocation(ctx)
    }
  }

  visitExpression?: ((ctx: ExprContext) => es.Expression) | undefined
  visitStart?: ((ctx: StatContext) => es.Expression) | undefined

  visit(tree: ParseTree): es.Expression {
    return tree.accept(this)
  }
  visitChildren(node: RuleNode): es.Expression {
    const expressions: es.Expression[] = []
    for (let i = 0; i < node.childCount; i++) {
      expressions.push(node.getChild(i).accept(this))
    }
    return {
      type: 'SequenceExpression',
      expressions
    }
  }
  visitTerminal(node: TerminalNode): es.Expression {
    return node.accept(this)
  }

  visitErrorNode(node: ErrorNode): es.Expression {
    throw new FatalSyntaxError(
      {
        start: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine
        },
        end: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine + 1
        }
      },
      `invalid syntax ${node.text}`
    )
  }
}

// function convertExpression(expression: ExprContext): es.Expression {
//   const generator = new ExpressionGenerator()
//   return expression.accept(generator)
// }

class StatementGenerator implements CalcVisitor<es.Statement> {
  visitExprStat(ctx: ExprStatContext): es.Statement {
    const generator = new ExpressionGenerator()
    return {
      type: 'ExpressionStatement',
      expression: ctx._expression.accept(generator),
      loc: contextToLocation(ctx)
    }
  }

  visitEmptStat(ctx: EmptStatContext): es.Statement {
    return {
      type: 'EmptyStatement',
      loc: contextToLocation(ctx)
    }
  }

  visit(tree: ParseTree): es.Statement {
    return tree.accept(this)
  }

  visitChildren(node: RuleNode): es.Statement {
    return node.accept(this)
  }

  visitTerminal(node: TerminalNode): es.Statement {
    return node.accept(this)
  }

  visitErrorNode(node: ErrorNode): es.Statement {
    throw new FatalSyntaxError(
      {
        start: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine
        },
        end: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine + 1
        }
      },
      `invalid syntax ${node.text}`
    )
  }
}

class ProgramGenerator implements CalcVisitor<es.Program> {
  visitProg(ctx: ProgContext): es.Program {
    const ESTreeProgram: es.Program = {
      type: 'Program',
      sourceType: 'script',
      body: []
    }

    //Debug
    // console.log("VISITPROG!!")

    const generator = new StatementGenerator()
    for (let i = 0; i < ctx.stat().length; i++) {
      //Debug
      // console.log(ctx.stat(i))

      ESTreeProgram.body.push(ctx.stat(i).accept(generator))

      //Debug
      // console.log('Statement converted.')
    }

    return ESTreeProgram
  }

  visit(tree: ParseTree): es.Program {
    return tree.accept(this)
  }

  visitChildren(node: RuleNode): es.Program {
    return node.accept(this)
  }

  visitTerminal(node: TerminalNode): es.Program {
    return node.accept(this)
  }

  visitErrorNode(node: ErrorNode): es.Program {
    throw new FatalSyntaxError(
      {
        start: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine
        },
        end: {
          line: node.symbol.line,
          column: node.symbol.charPositionInLine + 1
        }
      },
      `invalid syntax ${node.text}`
    )
  }
}

function convertProgram(prog: ProgContext): es.Program {
  const generator = new ProgramGenerator()
  return prog.accept(generator)
}

// function convertSource(expr: ExprContext): es.Program {
//   return {
//     type: 'Program',
//     sourceType: 'script',
//     body: [
//       {
//         type: 'ExpressionStatement',
//         expression: convertExpression(expr)
//       }
//     ]
//   }
// }

export function parse(source: string, context: Context) {
  let program: es.Program | undefined

  if (context.variant === 'calc') {
    const inputStream = new ANTLRInputStream(source)
    const lexer = new CalcLexer(inputStream)
    const tokenStream = new CommonTokenStream(lexer)
    const parser = new CalcParser(tokenStream)
    parser.buildParseTree = true
    try {
      const tree = parser.prog() // Use the rule "prog" to parse the file

      //Debug
      console.log('ANTLR AST Detected!')
      console.log(tree.toStringTree(parser))

      program = convertProgram(tree) // Convert the ANTLR generated AST to human-friendly AST ESTree

      //Debug
      console.log('ESTree AST:')
      console.log(program)
      
    } catch (error) {
      if (error instanceof FatalSyntaxError) {
        //Debug
        console.log('[ERROR] SyntaxError Detected')

        context.errors.push(error)
      } else {
        //Debug
        console.log('[ERROR] Unknown Error Detected')

        throw error
      }
    }
    const hasErrors = context.errors.find(m => m.severity === ErrorSeverity.ERROR)
    if (program && !hasErrors) {
      return program
    } else {
      return undefined
    }
  } else {
    return undefined
  }
}
