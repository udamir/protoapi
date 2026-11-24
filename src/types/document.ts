// The ProtoApi 0.1 document: the types of spec §9 (docs/spec/v0.1.md), one interface per object of spec §3.2.

/** Syntaxes and editions this version of protoapi supports. */
export type KnownProtoSyntax = "proto2" | "proto3" | "2023" | "2024" | "2026"

/**
 * `syntax` of a file: a known syntax or edition, or an edition this version does not know, written verbatim with an `unsupported` issue (spec §3.3). Verbatim spelling: the text producer writes the string of the `edition` statement (`"2027"`, `"UNSTABLE"`); the descriptor producer writes the `Edition` enum name without the `EDITION_` prefix (`EDITION_UNSTABLE` -> `"UNSTABLE"`, `EDITION_MAX` -> `"MAX"`), an edition number without a name as its decimal string (`1003` -> `"1003"`), and `syntax: "editions"` without an edition as `"editions"`. Features of such files resolve with the defaults of the newest known edition.
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
   * Absent only for a `.proto` file with a syntax error before its first statement was complete: the producer does not guess a syntax it could not read. A syntax error later in the file keeps the syntax and package statements parsed before it.
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
  /** annotation sources that disagree on a keyword (the higher source is kept, spec §3.8) */
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
   * Options of extension ranges other than `declaration` (`verification`, `features`, custom options): one entry per declared range that has such options, sorted by range start. `declaration` stays under `options.extension_declarations`.
   */
  extensionOptions?: ProtoApiExtensionRangeOptions[]
  /**
   * The resolved `features.json_format` when it is not ALLOW (spec §3.5 rule D): `"LEGACY_BEST_EFFORT"` on every proto2 message and on editions messages that resolve to it. Absent means ALLOW, the proto3 / editions default.
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
   * Resolved features against the fixed modern baseline (spec §3.5 rule D); absent means the proto3 / editions default. `packed: false`: a packable repeated field (numeric or enum) whose resolved encoding is EXPANDED (proto2 without `[packed = true]`, proto3 `[packed = false]`, editions `repeated_field_encoding = EXPANDED`). `options` never carries `packed` or `features.repeated_field_encoding`.
   */
  packed?: false
  /**
   * A `string` field whose resolved `utf8_validation` is NONE (every proto2 string, editions NONE). Written on the
   * string position: the field itself, `items` of a repeated field, `propertyNames` / `additionalProperties` of a map.
   * `options` never carries `features.utf8_validation`.
   */
  utf8Validation?: false
  /** annotation-level requiredness (spec §3.8): tags, prefixes, convention options; wire-level is `presence: "required"` */
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
  /** the resolved `features.json_format` when it is not ALLOW, as on messages (spec §3.5 rule D) */
  jsonFormat?: "LEGACY_BEST_EFFORT" | (string & {})
}
