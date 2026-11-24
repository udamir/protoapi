/**
 * Origin: pbkit 0.0.72, `core/ast/lexical-elements.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./../LICENSE-MIT, ./../LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only imports.
 */
import type { Span, Token } from "../scanner.ts"
import type { StatementBase } from "./index.ts"
import type { TextprotoMessageStatement } from "./textproto.ts"

export type Node =
  | CommentGroup
  | SinglelineComment
  | MultilineComment
  | Keyword
  | Type
  | FullIdent
  | Ident
  | Dot
  | Comma
  | Semi
  | IntLit
  | SignedIntLit
  | FloatLit
  | SignedFloatLit
  | BoolLit
  | StrLit
  | Aggregate
  | Empty

export interface CommentGroup extends Span {
  type: "comment-group"
  comments: Comment[]
}

export type Comment = SinglelineComment | MultilineComment

/** `// ...` comment. `text` includes the terminating newline (`\n` or `\r\n`) when there is one. */
export interface SinglelineComment extends Token {
  type: "singleline-comment"
}

/** `/* ... *\/` comment. */
export interface MultilineComment extends Token {
  type: "multiline-comment"
}

export interface Keyword extends Token {
  type: "keyword"
}

export interface Type extends Span {
  type: "type"
  identOrDots: (Ident | Dot)[]
}

export interface FullIdent extends Span {
  type: "full-ident"
  identOrDots: (Ident | Dot)[]
}

export interface Ident extends Token {
  type: "ident"
}

export interface Dot extends Token {
  type: "dot"
}

export interface Comma extends Token {
  type: "comma"
}

export interface Semi extends Token {
  type: "semi"
}

export interface IntLit extends Token {
  type: "int-lit"
}

export interface SignedIntLit extends Span {
  type: "signed-int-lit"
  sign?: Token
  value: IntLit
}

export interface FloatLit extends Token {
  type: "float-lit"
}

export interface SignedFloatLit extends Span {
  type: "signed-float-lit"
  sign?: Token
  value: FloatLit
}

export interface BoolLit extends Token {
  type: "bool-lit"
}

/** One or more adjacent string literal tokens (`"a" 'b'`), concatenated by protoc. Token texts keep their quotes. */
export interface StrLit extends Span {
  type: "str-lit"
  tokens: Token[]
}

export interface Aggregate extends Span {
  type: "aggregate"
  bracketOpen: Token
  statements: TextprotoMessageStatement[]
  bracketClose: Token
}

export interface Empty extends StatementBase {
  type: "empty"
  semi: Semi
}

export type Constant = FullIdent | SignedIntLit | SignedFloatLit | StrLit | BoolLit | Aggregate
