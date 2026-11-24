// Build inputs and results: build options, issues, the source map and its `Location` / `Position` (spec §4, §5).

import type { ProtoApiDocument } from "./document.ts"

/** Which declarations a build emits (`BuildOptions.imports`). */
export type ImportsMode = "user" | "referenced" | "all"

export type JsonPointer = string

export interface Position {
  /** zero-based */
  line: number
  /** zero-based, UTF-16 code units */
  column: number
}

export interface Location {
  file: string
  start: Position
  /** exclusive */
  end: Position
}

export type SourceMap = Record<JsonPointer, Location>

export type BuildIssueCode =
  | "syntax"
  | "missing-import"
  | "unresolved-type"
  | "unresolved-extendee"
  | "unknown-option"
  | "invalid-option"
  | "invalid-number"
  | "duplicate-number"
  | "duplicate-name"
  | "reserved-conflict"
  | "annotation-conflict"
  | "invalid-tag"
  | "unsupported"
  | "no-source-info"
  /** a syntax or edition rule is broken (proto3 `required`, editions labels, removed options, naming style, …) */
  | "invalid-definition"

export interface BuildIssue {
  code: BuildIssueCode
  message: string
  file?: string
  location?: Location
  /** the document node concerned, when there is one */
  pointer?: JsonPointer
}

export type TagName =
  | "default"
  | "example"
  | "required"
  | "minimum"
  | "maximum"
  | "exclusiveMinimum"
  | "exclusiveMaximum"
  | "multipleOf"
  | "pattern"
  | "minLength"
  | "maxLength"
  | "minItems"
  | "maxItems"
  | "format"
  | "enum"
  | "readOnly"
  | "writeOnly"
  | "deprecated"
  | "title"

export interface BuildOptions {
  /** files whose declarations are emitted; default: every key of `sources` (text) / every non-import file (descriptors) */
  entry?: string[]
  /** Which declarations are emitted (default `"user"`): `"user"` emits the entry files and every non-bundled file reachable through imports of any kind in full, bundled files contribute the declarations referenced from emitted ones; `"referenced"` emits the entry files in full and only referenced declarations of every imported file; `"all"` emits every file of the build. A file is bundled when the build resolved it from the bundle (the built-in one or `bundle`); a file in `sources` or from the loader is a user file whatever its path. */
  imports?: ImportsMode
  /** @deprecated use `imports`: `true` is `imports: "all"`, `false` is `imports: "referenced"`. Passing both with different meanings is a `TypeError`. */
  includeImports?: boolean
  /** comment tags + prefixes + options (default) | options only | nothing lifted */
  annotations?: "all" | "options" | "none"
  /** rename a tag (`{ default: "DefaultValue" }`) or disable it (`false`) */
  tags?: Partial<Record<TagName, string | false>>
  /** default true */
  sourceMap?: boolean
  /** emit the `files` section and `file` keywords (default true) */
  files?: boolean
  /** override or add bundled files (path -> text) */
  bundle?: Record<string, string>
  /**
   * Text producer only: source-map and issue columns advance to the next multiple of `tabWidth` at a tab (default 4,
   * buf's tab stop; protoc uses 8). `\r`, `\f`, `\v` and a byte order mark have no width, as in buf. The descriptor
   * producer keeps the SourceCodeInfo spans as given.
   */
  tabWidth?: number
}

export type ProtoSources = Record<string, string>
export type ProtoLoader = (importPath: string) => string | undefined
export type AsyncProtoLoader = (importPath: string) => Promise<string | undefined> | string | undefined

export interface TextBuildOptions extends BuildOptions {
  loader?: ProtoLoader
}
export interface DescriptorBuildOptions extends BuildOptions {}

export interface BuildResult {
  document: ProtoApiDocument
  sourceMap: SourceMap
  issues: BuildIssue[]
}

/** ProtoJSON form of google.protobuf.FileDescriptorSet (or a buf image) */
export interface FileDescriptorSetJson {
  file: Record<string, unknown>[]
}
export type DescriptorDecoder = (bytes: Uint8Array) => FileDescriptorSetJson | Promise<FileDescriptorSetJson>
