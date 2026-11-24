// The state of printing one file: the writer, its imports, the editions feature chain, the scope stack short type names are printed from, and the messages printed so far. The render-* modules print into it.

import type { ProtoApiDocument, ProtoApiField, ProtoApiFile, ProtoApiTypeRef, ProtoSyntax } from "../types.ts"
import type { TagSpelling } from "../conventions/tags.ts"
import { featuresOf } from "../features.ts"
import { isEditions } from "../common/editions.ts"
import { isPlainObject } from "../common/objects.ts"
import { type Oracle, refFqn, scalarOf } from "./oracle.ts"
import { ImportTracker } from "./imports.ts"
import { Writer } from "./writer.ts"
import { FeatureChain } from "./feature-spelling.ts"
import { FileLayout, inferSyntax } from "./layout.ts"
import { shortestName, unresolvedName } from "./names.ts"
import type { AnnotationContext } from "./annotations.ts"

type Obj = Record<string, unknown>

/** What every printed file of one document shares. */
export interface PrintContext {
  doc: ProtoApiDocument
  oracle: Oracle
  indent: string
  /** tag spelling of the `tags` print option; undefined (`tags: false`): no comment annotations (tags, AIP prefixes, `Deprecated:` lines) */
  tag?: TagSpelling
  names: Set<string>
  /** `names` and the document's members (fields, oneofs, enum values, extensions, methods), for extendees and method types */
  members: Set<string>
  /** component key -> file it is printed in */
  placement: Map<string, string>
  /** files of the document (or of the printed output for documents without `files`) */
  files: Record<string, ProtoApiFile>
}

/** The features object of an options tree, if it has one. */
export const optionFeatures = (o: unknown): Obj | undefined => (isPlainObject(o) ? featuresOf(o) : undefined)

export class FilePrinter {
  readonly ctx: PrintContext
  readonly path: string
  readonly file: ProtoApiFile
  readonly syntax: ProtoSyntax
  readonly editions: boolean
  readonly out: Writer
  readonly imports: ImportTracker
  readonly features: FeatureChain
  readonly layout: FileLayout
  readonly annotations: AnnotationContext
  /** messages printed so far (a group message is printed by its field, a wrapper once) */
  readonly printed = new Set<string>()
  /** group messages owned by fields of the message being printed */
  fieldGroups = new Set<string>()
  /** message fqn or package used to print short type names */
  private scope: string

  constructor(ctx: PrintContext, path: string, file: ProtoApiFile) {
    this.ctx = ctx
    this.path = path
    this.file = file
    this.syntax = file.syntax ?? inferSyntax(ctx.doc, (k) => ctx.placement.get(k) === path)
    this.editions = isEditions(this.syntax)
    this.out = new Writer(ctx.indent)
    this.features = new FeatureChain(optionFeatures(file.options))
    this.scope = file.package ?? ""
    this.layout = new FileLayout(ctx.doc, ctx.placement, path, file.package)
    this.imports = new ImportTracker(ctx.oracle, ctx.files, path, file)
    this.annotations = { oracle: ctx.oracle, imports: this.imports, tag: ctx.tag }
  }

  /** Run `body` with `scope` as the scope of short type names (and `features` as the innermost features object of the feature chain, for message bodies); the scope, the feature chain and `fieldGroups` are restored afterwards. */
  within<T>(scope: string, body: () => T, features?: Obj): T {
    const outerScope = this.scope
    const outerGroups = this.fieldGroups
    this.scope = scope
    if (features) this.features.push(features)
    try {
      return body()
    } finally {
      if (features) this.features.pop()
      this.scope = outerScope
      this.fieldGroups = outerGroups
    }
  }

  /** The name of a referenced type (or extendee) from the current scope, importing its file when needed; shortened over `names`, or over `members` for an extendee or a method request / response type, which protoc looks up taking the first symbol of any kind. */
  typeName(ref: string, names = this.ctx.names): string {
    const fqn = refFqn(ref)
    if (!this.ctx.names.has(fqn)) return unresolvedName(fqn, this.file.package)
    this.imports.needType(this.ctx.placement.get(fqn) ?? this.ctx.oracle.typeFile(fqn))
    return shortestName(fqn, this.scope, names)
  }

  /** The type of a field or type reference: its scalar, else its referenced type. */
  typeOf(t: ProtoApiTypeRef | ProtoApiField): string {
    const scalar = scalarOf(t)
    if (scalar) return scalar
    if ("$ref" in t && t.$ref) return this.typeName(t.$ref)
    return "bytes"
  }
}
