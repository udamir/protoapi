// The vocabulary of the annotation conventions, shared by the lift (annotate.ts) and the printer: the positions of a field, the keyword candidates the lifts produce, and the input and result of the annotation layer.

import type { AnnotationConflict, AnnotationSource, BuildOptions, ProtoScalar } from "../types.ts"
import type { MEnum } from "../model.ts"

/** A position of a field: the field itself (""), its items, map keys or map values. */
export type Target = "" | "items" | "propertyNames" | "additionalProperties"

/** What the annotation layer needs to know about a position (field, items, map key, map value). */
export interface Slot {
  scalar?: ProtoScalar
  enumDef?: MEnum
  message?: boolean
  /** the message type of a message slot, when resolved */
  messageFqn?: string
  /** the wrapper well-known type a `scalar` slot comes from (`google.protobuf.StringValue`): wrappers take the tags
   *  and rules of their scalar (A-11, decision 6) */
  wrapper?: string
}

export interface FieldShape {
  self: Slot
  repeated?: Slot
  map?: { key: Slot; value: Slot }
}

/** The shape of a field: singular, repeated or map. */
export type ShapeKind = "singular" | "repeated" | "map"

/** The kind of element an annotation applies to. */
export type ElementKind = "field" | "message" | "enum" | "enumValue" | "service" | "method" | "oneof" | "file"

export interface AnnotationInput {
  kind: ElementKind
  leading?: string
  trailing?: string
  /** typed options of the element (mutated copy: lifted parts removed) */
  options: Record<string, unknown>
  shape?: FieldShape
  mode: NonNullable<BuildOptions["annotations"]>
  tags?: BuildOptions["tags"]
  /** keywords set on the element by an enclosing one (`openapiv2_schema.json_schema.required` of the message, A-13) */
  extra?: { keyword: string; value: unknown; source: AnnotationSource; option?: string }[]
  /** messages: the field a `json_schema.required` entry names (proto name or JSON name), if any */
  fieldOf?: (name: string) => string | undefined
}

export interface AnnotationResult {
  description?: string
  title?: string
  deprecation?: { reason?: string }
  /** keywords per target ("" = the element itself) */
  keywords: Record<Target, Record<string, unknown>>
  xDefault?: unknown
  conflicts: AnnotationConflict[]
  /** invalid comment tags, each as `@Tag value: reason` */
  invalidTags: string[]
  /** convention options not lifted because they do not fit the element (A-11): the option key and the reason */
  invalidOptions: { key: string; message: string }[]
  /** messages: the fields `openapiv2_schema.json_schema.required` names (A-13) */
  requiredFields?: string[]
  /** options left after lifting */
  options: Record<string, unknown>
  /** where each kept keyword came from (validation L-3: keyword-level source-map entries) */
  origins: KeywordOrigin[]
  /** where `deprecation` came from */
  deprecationOrigin?: { source: AnnotationSource; comment?: CommentLine }
}

/** A comment line of the element: the normalised line text and whether it is part of the trailing comment. */
export interface CommentLine {
  text: string
  trailing: boolean
}

export interface KeywordOrigin {
  target: Target
  keyword: string
  source: AnnotationSource
  /** the option key the keyword was lifted from (option sources) */
  option?: string
  /** the comment line of a tag or prefix */
  comment?: CommentLine
}

/** A keyword value one source proposes for a position; the merge keeps one per position and keyword. */
export interface Candidate {
  target: Target
  keyword: string
  value: unknown
  source: AnnotationSource
  option?: string
  comment?: CommentLine
}

/** The shape of a field described by `shape` (repeated before map). */
export const shapeKind = (shape: FieldShape | undefined): ShapeKind =>
  shape?.repeated ? "repeated" : shape?.map ? "map" : "singular"

/** The value position of a field: `items` on repeated fields, `additionalProperties` on maps (decision 5). */
export const valueTarget = (shape: ShapeKind): Target =>
  shape === "repeated" ? "items" : shape === "map" ? "additionalProperties" : ""

/** The slot of `target` in a field shape. */
export const slotOf = (shape: FieldShape | undefined, target: Target): Slot | undefined => {
  if (!shape) return undefined
  if (target === "") return shape.self
  if (target === "items") return shape.repeated
  if (target === "propertyNames") return shape.map?.key
  return shape.map?.value
}

/** Every annotation keyword a position can carry (design §3.2 order). */
export const ANNOTATION_KEYWORDS =
  "format readOnly writeOnly immutable minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minLength maxLength pattern minItems maxItems uniqueItems minProperties maxProperties enum const examples".split(
    " ",
  )
