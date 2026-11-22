/**
 * Origin: pbkit 0.0.72, `core/ast/fields.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./../LICENSE-MIT, ./../LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only imports.
 * - `OneofGroup.fieldOptions` added (`group Foo = 1 [deprecated = true] { ... }` inside a oneof).
 */
import type { Span, Token } from "../recursive-descent-parser"
import type { MalformedBase, Option, OptionName, StatementBase } from "./index"
import type { Comma, Constant, Empty, IntLit, Keyword, Semi, Type } from "./lexical-elements"
import type { MessageBody } from "./top-level-definitions"

export type Node =
  | Field
  | MalformedField
  | FieldOptions
  | FieldOption
  | Group
  | Oneof
  | OneofBody
  | OneofField
  | OneofGroup
  | MapField

export interface Field extends StatementBase {
  type: "field"
  fieldLabel?: Keyword
  fieldType: Type
  fieldName: Token
  eq: Token
  fieldNumber: IntLit
  fieldOptions?: FieldOptions
  semi: Semi
}

/**
 * A field statement that could only be parsed partially (pbkit's error recovery).
 * `parseProto` reports a syntax error whenever one is produced.
 */
export type MalformedField = MalformedBase<Field, "malformed-field", "fieldLabel" | "fieldType">

export interface FieldOptions extends Span {
  type: "field-options"
  bracketOpen: Token
  fieldOptionOrCommas: (FieldOption | Comma)[]
  bracketClose: Token
}

export interface FieldOption extends Span {
  type: "field-option"
  optionName: OptionName
  eq: Token
  constant: Constant
}

/** proto2 group field: `optional group Foo = 1 { ... }`. `trailingComments` are the ones after `{`. */
export interface Group extends StatementBase {
  type: "group"
  /** absent only for a label-less group (editions / proto3, where groups are an error but the file still parses) */
  groupLabel?: Keyword
  keyword: Keyword
  groupName: Token
  eq: Token
  fieldNumber: IntLit
  fieldOptions?: FieldOptions
  messageBody: MessageBody
}

/** `oneof name { ... }`. `trailingComments` are the ones after `{`. */
export interface Oneof extends StatementBase {
  type: "oneof"
  keyword: Keyword
  oneofName: Token
  oneofBody: OneofBody
}

export interface OneofBody extends Span {
  type: "oneof-body"
  bracketOpen: Token
  statements: OneofBodyStatement[]
  bracketClose: Token
}

export type OneofBodyStatement = Option | OneofField | OneofGroup | Empty

export interface OneofField extends StatementBase {
  type: "oneof-field"
  fieldType: Type
  fieldName: Token
  eq: Token
  fieldNumber: IntLit
  fieldOptions?: FieldOptions
  semi: Semi
}

/** `group Foo = 1 { ... }` inside a oneof. `trailingComments` are the ones after `{`. */
export interface OneofGroup extends StatementBase {
  type: "oneof-group"
  keyword: Keyword
  groupName: Token
  eq: Token
  fieldNumber: IntLit
  /** Addition (not in pbkit 0.0.72): options between the field number and the body. */
  fieldOptions?: FieldOptions
  messageBody: MessageBody
}

export interface MapField extends StatementBase {
  type: "map-field"
  keyword: Keyword
  typeBracketOpen: Token
  keyType: Type
  typeSep: Token
  valueType: Type
  typeBracketClose: Token
  mapName: Token
  eq: Token
  fieldNumber: IntLit
  fieldOptions?: FieldOptions
  semi: Semi
}
