// What the definition checks share: the build's symbols, its typed options and edition defaults (read through the lowering's `OptionsContext`), the source texts and the issue list.

import type { BuildIssue, BuildIssueCode, Location } from "../types.ts"
import type { MFile, MOptionHolder, OptionTree } from "../model.ts"
import type { SymbolTable } from "../symbols.ts"
import type { OptionsKind } from "../options/kinds.ts"
import { type ResolvedFeatures, resolveFeatures } from "../features.ts"
import type { OptionsContext } from "../lower/context.ts"

export interface ValidateInput {
  files: MFile[]
  symbols: SymbolTable
  /** the typed options and edition defaults of the lowering of this build */
  optionsContext: OptionsContext
  sources: Map<string, string>
  issues: BuildIssue[]
}

export class ValidateContext {
  readonly symbols: SymbolTable
  readonly sources: Map<string, string>
  private readonly options: OptionsContext
  private readonly issues: BuildIssue[]

  constructor(input: ValidateInput) {
    this.symbols = input.symbols
    this.sources = input.sources
    this.options = input.optionsContext
    this.issues = input.issues
  }

  issue(code: BuildIssueCode, message: string, file: MFile, pointer: string, location?: Location) {
    this.issues.push({ code, message, file: file.path, pointer, location })
  }

  /** The typed options of `holder` (interpreted by the lowering, see `OptionsContext.opts`). */
  opts(holder: MOptionHolder, kind: OptionsKind, file: MFile, scope: string): OptionTree {
    return this.options.opts(holder, kind, file, scope)
  }

  features(file: MFile, chain: OptionTree[]): ResolvedFeatures {
    return resolveFeatures(this.options.defaults(file.syntax), file.syntax, chain)
  }
}
