// The state of one lowering: the typed options and edition defaults of the build (`OptionsContext`, also read by the validator) and what the element lowerers share (`LowerContext`).

import type { BuildIssue, BuildOptions, ImportsMode, Location, ProtoApiDocument, SourceMap } from "../types.ts"
import type { MFile, MMessage, MOptionHolder, OptionTree, PendingIssue } from "../model.ts"
import type { SymbolTable } from "../symbols.ts"
import type { OptionsKind } from "../options/kinds.ts"
import { OptionInterpreter } from "../options/interpret.ts"
import { annotate } from "../annotate.ts"
import type { AnnotationInput, AnnotationResult } from "../conventions/types.ts"
import {
  BUNDLED_FEATURE_DEFAULTS,
  FeatureDefaults,
  type ResolvedFeatures,
  featureDefaultsSource,
  mergeFeatureDefaults,
} from "../features.ts"
import { ptr } from "../paths.ts"
import { SourceMapWriter } from "./sourcemap.ts"

export interface LowerInput {
  /** every file known to the build (user files and loaded bundle files) */
  files: MFile[]
  /** entry file paths in entry order */
  entry: string[]
  symbols: SymbolTable
  options: BuildOptions
  /** emission mode (`BuildOptions.imports`, the `includeImports` alias resolved) */
  imports: ImportsMode
  /** source text by file path (text producer) */
  sources: Map<string, string>
  issues: BuildIssue[]
}

export interface LowerOutput {
  document: ProtoApiDocument
  sourceMap: SourceMap
}

/** Edition defaults read from a FeatureSet definition; cached per (bundled, reused) model object. */
const definitionDefaults = new WeakMap<MMessage, FeatureDefaults>()

/** The typed options of the build's elements, interpreted once per build, and the edition defaults of the build. */
export class OptionsContext {
  private readonly interpreted = new WeakSet<MOptionHolder>()
  private featureDefaults?: FeatureDefaults
  private readonly symbols: SymbolTable
  private readonly sources: Map<string, string>

  constructor(symbols: SymbolTable, sources: Map<string, string>) {
    this.symbols = symbols
    this.sources = sources
  }

  /** The typed options of `holder`, interpreted once per build (`scope`: where option names are looked up from). */
  opts(holder: MOptionHolder, kind: OptionsKind, file: MFile, scope: string): OptionTree {
    if (!this.interpreted.has(holder)) {
      this.interpreted.add(holder)
      if (!holder.raw.length) {
        holder.options = {}
        return holder.options
      }
      new OptionInterpreter({ symbols: this.symbols, file, scope, source: this.sources.get(file.path) }, holder).run(
        kind,
        file.syntax,
      )
    }
    return holder.options
  }

  /**
   * Edition defaults (F-4): the `edition_defaults` of `google.protobuf.FeatureSet` in the descriptor.proto of this
   * build (a user-supplied one wins over the bundle, design §5.2); features it does not define, or a build without a
   * descriptor.proto (protoapi/core), use the bundled descriptor.proto's defaults.
   */
  defaults(syntax: MFile["syntax"]): ResolvedFeatures {
    if (!this.featureDefaults) {
      const fs = this.symbols.message("google.protobuf.FeatureSet")
      let table = fs ? definitionDefaults.get(fs) : BUNDLED_FEATURE_DEFAULTS
      if (!table && fs) {
        const editions = this.symbols.enum("google.protobuf.Edition")
        const own = featureDefaultsSource(
          fs.fields.map((f) => ({
            name: f.name,
            editionDefaults: this.opts(f, "field", fs.file, fs.fqn).edition_defaults,
          })),
          (editions?.values ?? []).map((v) => ({ name: v.name, number: v.number })),
        )
        table = new FeatureDefaults(mergeFeatureDefaults(BUNDLED_FEATURE_DEFAULTS.source, own))
        definitionDefaults.set(fs, table)
      }
      this.featureDefaults = table ?? BUNDLED_FEATURE_DEFAULTS
    }
    return this.featureDefaults.forSyntax(syntax)
  }
}

/** What the element lowerers share: the input, its typed options, the issue list, the source map and the annotation mode. */
export class LowerContext extends OptionsContext {
  readonly input: LowerInput
  readonly sourceMap: SourceMapWriter
  readonly useFiles: boolean
  readonly mode: NonNullable<BuildOptions["annotations"]>
  readonly entry: Set<string>

  constructor(input: LowerInput) {
    super(input.symbols, input.sources)
    this.input = input
    this.entry = new Set(input.entry)
    this.sourceMap = new SourceMapWriter(input.options.sourceMap !== false)
    this.useFiles = input.options.files !== false
    this.mode = input.options.annotations ?? "all"
  }

  issue(code: BuildIssue["code"], message: string, file: MFile, pointer: string, location?: Location) {
    this.input.issues.push({ code, message, file: file.path, pointer, location })
  }

  /** The pending issues of a model element, emitted below its pointer (`fallback`: their location when they have none). */
  flush(holder: { pending?: PendingIssue[] }, pointer: string, file: MFile, fallback?: Location) {
    for (const p of holder.pending ?? []) {
      this.input.issues.push({
        code: p.code,
        message: p.message,
        file: file.path,
        location: p.loc ?? fallback,
        pointer: p.sub ? `${pointer}/${p.sub.split("/").map(ptr).join("/")}` : pointer,
      })
    }
    holder.pending = undefined
  }

  /** The annotation layer for an element: its comments and options in the build's mode and tags. */
  annotate(
    kind: AnnotationInput["kind"],
    el: { comments: { leading?: string; trailing?: string } },
    options: OptionTree,
    more?: Partial<AnnotationInput>,
  ): AnnotationResult {
    return annotate({
      kind,
      leading: el.comments.leading,
      trailing: el.comments.trailing,
      options,
      mode: this.mode,
      tags: this.input.options.tags,
      ...more,
    })
  }
}
