// ProtoApi 0.1 document format (design §3.2) and the public build / print / locate types (design §4.3).

/** Syntaxes and editions this version of protoapi supports. */
export type KnownProtoSyntax = "proto2" | "proto3" | "2023" | "2024" | "2026"

/**
 * `syntax` of a file: a known syntax or edition, or an edition this version does not know, written verbatim with an
 * `unsupported` issue (validation decision D-C). Verbatim spelling: the text producer writes the string of the
 * `edition` statement (`"2027"`, `"UNSTABLE"`); the descriptor producer writes the `Edition` enum name without the
 * `EDITION_` prefix (`EDITION_UNSTABLE` -> `"UNSTABLE"`, `EDITION_MAX` -> `"MAX"`), an edition number without a name as
 * its decimal string (`1003` -> `"1003"`), and `syntax: "editions"` without an edition as `"editions"`. Features of
 * such files resolve with the defaults of the newest known edition.
 */
export type ProtoSyntax = KnownProtoSyntax | (string & {})

export interface ProtoApiDocument {
  protoapi: "0.1"
  files?: Record<string, ProtoApiFile>
  services?: Record<string, ProtoApiService>
  components?: {
    messages?: Record<string, ProtoApiMessage>
    enums?: Record<string, ProtoApiEnum>
    extensions?: Record<string, ProtoApiExtension>
  }
}

export interface ProtoApiFile {
  /** detached comment block(s) at the top of the file, if any; never on a file marked `bundled` (its licence header) */
  description?: string
  /**
   * Absent only for a `.proto` file with a syntax error before its first statement was complete: the producer does
   * not guess a syntax it could not read (validation text#14). A syntax error later in the file keeps the syntax and
   * package statements parsed before it.
   */
  syntax?: ProtoSyntax
  package?: string
  /** import paths as written, in order */
  imports?: string[]
  /** only for imports with a modifier */
  importFlags?: Record<string, "public" | "weak" | "option">
  /** file options not lifted (go_package, java_package, features, custom …) */
  options?: ProtoOptions
  /** The build resolved this file from the bundle (the built-in one or `BuildOptions.bundle`) and it is not an entry file: in the default `imports: "user"` mode it contributes only the declarations referenced from emitted ones. The printer does not print such files (they resolve from the bundle when rebuilt). */
  bundled?: true
}

/** Which declarations a build emits (`BuildOptions.imports`). */
export type ImportsMode = "user" | "referenced" | "all"

export interface ProtoApiElement {
  /** short name (last identifier) on services and components; `@Title` / openapiv2 title elsewhere */
  title?: string
  /** declaring file; on services, messages, enums and extensions */
  file?: string
  /** leading + trailing comment, tags and prefixes removed, whitespace normalised */
  description?: string
  /** `deprecated = true` and / or `Deprecated:` line / `@Deprecated` tag */
  deprecation?: { reason?: string }
  /** every option not lifted into a keyword */
  options?: ProtoOptions
  /** annotation sources that disagree on a keyword (the higher source is kept, design §3.8) */
  "x-annotation-conflicts"?: AnnotationConflict[]
}

export type ProtoOptions = Record<string, ProtoOptionValue>
export type ProtoOptionValue = string | number | boolean | ProtoOptionValue[] | { [key: string]: ProtoOptionValue }

export interface ProtoApiService extends ProtoApiElement {
  methods: Record<string, ProtoApiMethod>
}

export interface ProtoApiMethodMessage {
  /** nominal reference to components/messages/<fqn> */
  schema: { $ref: string }
  stream?: true
}

export interface ProtoApiHttpRule {
  /** GET, PUT, POST, DELETE, PATCH or a custom kind as written */
  method: string
  path: string
  body?: string
  responseBody?: string
  additionalBindings?: ProtoApiHttpRule[]
}

export interface ProtoApiMethod extends ProtoApiElement {
  request: ProtoApiMethodMessage
  response: ProtoApiMethodMessage
  /** IDEMPOTENCY_UNKNOWN is not written */
  idempotency?: "NO_SIDE_EFFECTS" | "IDEMPOTENT"
  /** google.api.http, normalised */
  http?: ProtoApiHttpRule
}

export type ProtoScalar =
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "float"
  | "double"
  | "bool"
  | "string"
  | "bytes"

/** JSON Schema vocabulary lifted by the annotation layer; also valid on `items`, `propertyNames`, `additionalProperties` */
export interface ProtoApiAnnotations {
  format?: string
  readOnly?: true
  writeOnly?: true
  immutable?: true
  minimum?: number | string
  maximum?: number | string
  exclusiveMinimum?: number | string
  exclusiveMaximum?: number | string
  multipleOf?: number | string
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  uniqueItems?: true
  minProperties?: number
  maxProperties?: number
  enum?: (string | number)[]
  const?: string | number | boolean
  examples?: unknown[]
}

export interface ProtoApiScalarRef extends ProtoApiAnnotations {
  /** the protobuf scalar type */
  type: ProtoScalar
  /** `items` / map key / map value of type `string` whose resolved `utf8_validation` is NONE (see ProtoApiField) */
  utf8Validation?: false
}
export interface ProtoApiNamedRef extends ProtoApiAnnotations {
  $ref: string
}
export type ProtoApiTypeRef = ProtoApiScalarRef | ProtoApiNamedRef

export interface ProtoApiMessage extends ProtoApiElement {
  type: "object"
  /** declaration order */
  properties: Record<string, ProtoApiField>
  /** real oneof declarations; members carry `oneof: <name>` */
  oneofs?: Record<string, ProtoApiElement>
  reserved?: ProtoApiReserved
  /** `extensions a to b;` as sorted merged inclusive intervals; `max` = 536870911 */
  extensions?: [number, number][]
  /**
   * Options of extension ranges other than `declaration` (`verification`, `features`, custom options): one entry per
   * declared range that has such options, sorted by range start (validation F-1). `declaration` stays under
   * `options.extension_declarations`.
   */
  extensionOptions?: ProtoApiExtensionRangeOptions[]
  /**
   * The resolved `features.json_format` when it is not ALLOW (validation F-3): `"LEGACY_BEST_EFFORT"` on every proto2
   * message and on editions messages that resolve to it. Absent means ALLOW, the proto3 / editions default.
   */
  jsonFormat?: "LEGACY_BEST_EFFORT" | (string & {})
}

export interface ProtoApiExtensionRangeOptions {
  /** inclusive, as in `extensions` */
  range: [number, number]
  options: ProtoOptions
}

export interface ProtoApiReserved {
  /** sorted, merged, inclusive */
  numbers?: [number, number][]
  /** sorted */
  names?: string[]
}

export interface ProtoApiField extends ProtoApiElement, ProtoApiAnnotations {
  number: number
  /** a protobuf scalar type, `array` (repeated) or `object` (map) */
  type?: ProtoScalar | "array" | "object"
  $ref?: string
  items?: ProtoApiTypeRef
  additionalProperties?: ProtoApiTypeRef
  propertyNames?: ProtoApiScalarRef
  presence?: "explicit" | "required"
  oneof?: string
  jsonName?: string
  /** proto2 / editions `[default = x]` only, canonical */
  default?: string | number | boolean
  /** proto2 group / editions message_encoding = DELIMITED */
  delimited?: true
  /**
   * Resolved features against the fixed modern baseline (validation F-3); absent means the proto3 / editions default.
   * `packed: false`: a packable repeated field (numeric or enum) whose resolved encoding is EXPANDED (proto2 without
   * `[packed = true]`, proto3 `[packed = false]`, editions `repeated_field_encoding = EXPANDED`). `options` never
   * carries `packed` or `features.repeated_field_encoding`.
   */
  packed?: false
  /**
   * A `string` field whose resolved `utf8_validation` is NONE (every proto2 string, editions NONE). Written on the
   * string position: the field itself, `items` of a repeated field, `propertyNames` / `additionalProperties` of a map.
   * `options` never carries `features.utf8_validation`.
   */
  utf8Validation?: false
  /** annotation-level requiredness (S1): tags, prefixes, convention options; wire-level is `presence: "required"` */
  required?: true
  "x-default"?: unknown
}

export interface AnnotationConflict {
  keyword: string
  kept: { source: AnnotationSource; value: unknown }
  dropped: { source: AnnotationSource; value: unknown }
}
export type AnnotationSource =
  | "option"
  | "google.api"
  | "buf.validate"
  | "validate.rules"
  | "openapiv2"
  | "tag"
  | "prefix"

export interface ProtoApiExtension extends ProtoApiField {
  /** fully qualified extended message, no leading dot */
  extendee: string
}

export interface ProtoApiEnumValue extends ProtoApiElement {
  number: number
}

export interface ProtoApiEnum extends ProtoApiElement {
  type: "string"
  /** declaration order; aliases are two names with one number */
  values: Record<string, ProtoApiEnumValue>
  reserved?: ProtoApiReserved
  /** proto2, or editions enum_type = CLOSED */
  closed?: true
  /** the resolved `features.json_format` when it is not ALLOW, as on messages (validation F-3) */
  jsonFormat?: "LEGACY_BEST_EFFORT" | (string & {})
}

// ---- building ----------------------------------------------------------------------------------------------------

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

export interface PrintOptions {
  /** default two spaces */
  indent?: string
  /**
   * Comment annotations for keywords no available option can carry: `true` (default) prints comment tags, AIP
   * prefixes and `Deprecated:` lines; `false` prints none (for documents built with `annotations: "options"` or
   * `"none"`); a map renames or disables tags like `BuildOptions.tags` (pass the build's map, validation decision 13).
   */
  tags?: boolean | Partial<Record<TagName, string | false>>
  /** for documents without `files` (default "protoapi.proto") */
  fileName?: string
  /**
   * `.proto` sources (import path -> text) whose definitions type option values and names that the document does not
   * hold, typically the build's own sources when it ran with `imports: "referenced"` (option definitions of
   * imported files are not in the document). Bundled files are always consulted.
   */
  sources?: ProtoSources
}
