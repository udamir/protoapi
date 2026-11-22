/**
 * Origin: pbkit 0.0.72, `core/ast/extensions-and-reserved.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./../LICENSE-MIT, ./../LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only imports.
 * - `FieldNames.strLitOrCommas` may also hold `Ident` nodes (editions: `reserved OLD, LEGACY;`).
 */
import type { Span, Token } from "../recursive-descent-parser"
import type { FieldOptions } from "./fields"
import type { StatementBase } from "./index"
import type { Comma, Ident, Keyword, Semi, SignedIntLit, StrLit } from "./lexical-elements"

export type Node = Extensions | Ranges | Range | Max | Reserved | FieldNames

/** `extensions 100 to 199 [declaration = { ... }];` */
export interface Extensions extends StatementBase {
  type: "extensions"
  keyword: Keyword
  ranges: Ranges
  fieldOptions?: FieldOptions
  semi: Semi
}

export interface Ranges extends Span {
  type: "ranges"
  rangeOrCommas: (Range | Comma)[]
}

export interface Range extends Span {
  type: "range"
  rangeStart: SignedIntLit
  to?: Keyword
  rangeEnd?: SignedIntLit | Max
}

export interface Max extends Token {
  type: "max"
}

export interface Reserved extends StatementBase {
  type: "reserved"
  keyword: Keyword
  reserved: Ranges | FieldNames
  semi: Semi
}

/**
 * Reserved names. proto2 / proto3 write them as string literals (`reserved "foo", "bar";`), editions as bare
 * identifiers (`reserved foo, bar;`). Both spellings are accepted regardless of the file's syntax, and may even be
 * mixed; the field keeps pbkit's name `strLitOrCommas` for compatibility.
 */
export interface FieldNames extends Span {
  type: "field-names"
  strLitOrCommas: (StrLit | Ident | Comma)[]
}
