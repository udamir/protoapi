// What the option interpreter works with: the lookup context of one option holder, and the base of its layers
// (text format values, option statements, ProtoJSON, the whole holder) with issue reporting and source text.

import type { Location } from "../types.ts"
import { type MFile, type MOptionHolder, type PendingIssue, addPending } from "../model/index.ts"
import type { SymbolTable } from "../symbols.ts"
import type { Spanned } from "../frontend/text/nodes.ts"

export interface OptionContext {
  symbols: SymbolTable
  file: MFile
  /** fully qualified scope for extension name lookup (element fqn, or package for files) */
  scope: string
  /** source text of the file (text producer) */
  source?: string
}

/** The state shared by the interpreter's layers: the context, the holder whose options are interpreted and the issue pointer. */
export class OptionReader {
  protected readonly ctx: OptionContext
  protected readonly holder: MOptionHolder

  constructor(ctx: OptionContext, holder: MOptionHolder) {
    this.ctx = ctx
    this.holder = holder
  }

  /** the pointer suffix of the option statement being interpreted (issues inside aggregate values point at it) */
  protected currentSub?: string

  protected issue(code: PendingIssue["code"], message: string, loc?: Location, sub?: string) {
    addPending(this.holder, { code, message, loc, sub: sub ?? this.currentSub })
  }

  protected src(node: Spanned): string {
    return this.ctx.source ? this.ctx.source.slice(node.start, node.end) : ""
  }

  /** Where option names and values look names up from: the file, with `import option` files visible (decision 18). */
  protected get from() {
    return { file: this.ctx.file, options: true }
  }
}
