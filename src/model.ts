// Internal resolved model (design §4.2 `model/`), produced by both front ends and consumed by the lowering.
// Everything from the model onward (option typing, features, lowering, annotations, source map) is shared, which is
// what makes the conformance test a test of the two front ends only.

import type { BuildIssueCode, Location, ProtoScalar, ProtoSyntax } from "./types.ts"
import type { Constant, OptionName } from "./parser/index.ts"

/** Source locations of an element and its parts. Keys: "" (whole element) and sub-keys such as "name", "number",
 *  "type", "label", "jsonName", "default", "extendee", "request", "response", "request/stream", "response/stream",
 *  "options/<key>" (option statements by top-level option key), "reserved", "extensions". */
export type Locs = Record<string, Location>

/** Comment text in protoc's `SourceCodeInfo` form (markers removed, see `comments.ts`). */
export interface MComments {
  leading?: string
  trailing?: string
}

/** Options as delivered by a front end, before typing against the definitions. */
export type MRawOption =
  | {
      kind: "text"
      name: OptionName
      value: Constant
      /** source text of the constant, kept for unknown options */
      text: string
      loc?: Location
      /** the whole statement, when `loc` is the IN-5 "name to `}`" span (used for repeated fields, C-10) */
      stmtLoc?: Location
    }
  | {
      kind: "json"
      /** the whole ProtoJSON `*Options` message */
      value: Record<string, unknown>
      /** option locations by option field number path, e.g. "1159" for buf.validate.field */
      locs?: Record<string, Location>
    }

/** Canonical typed option tree: keys are built-in field names or extension fqns, values canonical (design §3.6). */
export type OptionTree = Record<string, unknown>

/** An issue found before lowering; the lowering attaches the element's pointer (plus `sub`) when it emits it. */
export interface PendingIssue {
  code: BuildIssueCode
  message: string
  loc?: Location
  /** pointer suffix below the element, e.g. "options/other.flags.hidden" */
  sub?: string
}

/** Record an issue on a model element, to be emitted by the lowering. */
export const addPending = (holder: { pending?: PendingIssue[] }, issue: PendingIssue) => {
  if (!holder.pending) holder.pending = []
  holder.pending.push(issue)
}

export interface MOptionHolder {
  pending?: PendingIssue[]
  raw: MRawOption[]
  /** filled by option interpretation */
  options: OptionTree
  /** top-level option key -> location of the (first) option statement setting it */
  optionLocs: Record<string, Location>
}

export type MTypeRef =
  | { kind: "scalar"; scalar: ProtoScalar }
  | {
      kind: "named"
      /** as written (text) or fully qualified with a leading dot (descriptors) */
      name: string
      /** resolved by name resolution */
      resolved?: { kind: "message" | "enum"; fqn: string }
      /** best-effort key for unresolved names (design §5.3) */
      unresolvedKey?: string
      /** descriptor hint: TYPE_MESSAGE / TYPE_GROUP / TYPE_ENUM */
      hint?: "message" | "enum"
    }

export interface MField extends MOptionHolder {
  name: string
  number: number
  repeated: boolean
  /** `required` label */
  required: boolean
  /** explicit `optional` label (proto2, or proto3 optional) */
  optional: boolean
  type: MTypeRef
  map?: { key: ProtoScalar; value: MTypeRef }
  /** proto2 group syntax / TYPE_GROUP */
  group?: boolean
  /** name of the real oneof the field belongs to */
  oneof?: string
  /** explicit json_name (text) / descriptor json_name */
  jsonName?: string
  /** raw default: text constant or descriptor `default_value` string */
  default?: { kind: "text"; value: Constant } | { kind: "descriptor"; value: string }
  /** extension fields only: fully qualified extension name */
  fqn?: string
  /** extension fields only */
  extendee?: { name: string; resolved?: string; unresolvedKey?: string }
  comments: MComments
  locs: Locs
}

export interface MOneof extends MOptionHolder {
  name: string
  comments: MComments
  locs: Locs
}

export interface MExtensionRange extends MOptionHolder {
  start: number
  /** inclusive */
  end: number
  /** written as `to max` (message sets use a larger maximum) */
  toMax?: boolean
  loc?: Location
  /** text producer: location of the range itself (`100 to 199`) */
  rangeLoc?: Location
}

export interface MMessage extends MOptionHolder {
  name: string
  fqn: string
  fields: MField[]
  oneofs: MOneof[]
  nested: MMessage[]
  enums: MEnum[]
  extensions: MField[]
  /** inclusive ranges as written */
  reservedRanges: [number, number][]
  reservedNames: string[]
  /** text producer: location of each reserved range / name, parallel to `reservedRanges` / `reservedNames` */
  reservedLocs?: { ranges: (Location | undefined)[]; names: (Location | undefined)[] }
  extensionRanges: MExtensionRange[]
  /** descriptor map entry messages (folded into the map field, never emitted) */
  mapEntry?: boolean
  visibility?: "export" | "local"
  comments: MComments
  locs: Locs
  file: MFile
}

export interface MEnumValue extends MOptionHolder {
  name: string
  number: number
  comments: MComments
  locs: Locs
}

export interface MEnum extends MOptionHolder {
  name: string
  fqn: string
  values: MEnumValue[]
  reservedRanges: [number, number][]
  reservedNames: string[]
  /** text producer: location of each reserved range / name, parallel to `reservedRanges` / `reservedNames` */
  reservedLocs?: { ranges: (Location | undefined)[]; names: (Location | undefined)[] }
  visibility?: "export" | "local"
  comments: MComments
  locs: Locs
  file: MFile
}

export interface MMethod extends MOptionHolder {
  name: string
  input: MTypeRef
  output: MTypeRef
  clientStreaming: boolean
  serverStreaming: boolean
  comments: MComments
  locs: Locs
}

export interface MService extends MOptionHolder {
  name: string
  fqn: string
  methods: MMethod[]
  comments: MComments
  locs: Locs
  file: MFile
}

export interface MImport {
  path: string
  flag?: "public" | "weak" | "option"
  loc?: Location
}

export interface MFile extends MOptionHolder {
  path: string
  syntax: ProtoSyntax
  /** "" when the file has no package */
  package: string
  imports: MImport[]
  /** header comment (detached comment above syntax / package) */
  header?: string
  messages: MMessage[]
  enums: MEnum[]
  extensions: MField[]
  services: MService[]
  locs: Locs
  /** The build resolved the file from the bundle (the built-in one or `BuildOptions.bundle`, design §5.2); for a descriptor set, its path is a key of the bundle in effect. Marked `bundled: true` in `files` unless an entry (U3). */
  bundled?: boolean
  /** descriptor sets: bufExtension.isImport */
  isImport?: boolean
  /** false when the file failed to parse */
  parsed: boolean
  /** a file that failed to parse before its syntax could be read: `syntax` is a placeholder, not written (text#14) */
  syntaxUnknown?: boolean
  /** text producer: the file is validated (design D-E checks run on it) */
  validate?: boolean
}

export const newHolder = (): MOptionHolder => ({ raw: [], options: {}, optionLocs: {} })
