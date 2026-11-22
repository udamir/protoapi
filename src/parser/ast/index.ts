/**
 * Origin: pbkit 0.0.72, `core/ast/index.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./../LICENSE-MIT, ./../LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only imports / re-exports.
 * - `Import.weakOrPublic` documented to also hold `option` (edition 2024 `import option "x.proto";`).
 * - comment semantics of `StatementBase` follow buf 1.75 (see KNOWN_DEVIATIONS in ../proto.ts).
 */
import type { Span, Token } from "../recursive-descent-parser"
import type * as extensionsAndReserved from "./extensions-and-reserved"
import type * as fields from "./fields"
import type * as lexicalElements from "./lexical-elements"
import type { CommentGroup, Constant, Dot, Empty, FullIdent, Keyword, Semi, StrLit } from "./lexical-elements"
import type * as textproto from "./textproto"
import type * as topLevelDefinitions from "./top-level-definitions"
import type {
  Enum,
  EnumBodyStatement,
  Extend,
  ExtendBodyStatement,
  Message,
  MessageBodyStatement,
  RpcBodyStatement,
  Service,
  ServiceBodyStatement,
} from "./top-level-definitions"

export type * from "./extensions-and-reserved"
export type * from "./fields"
export type * from "./lexical-elements"
export type * from "./textproto"
export type * from "./top-level-definitions"

export interface Proto {
  statements: TopLevelStatement[]
}

export type Node =
  | index_Node
  | extensionsAndReserved.Node
  | fields.Node
  | lexicalElements.Node
  | textproto.Node
  | topLevelDefinitions.Node

type index_Node = Syntax | Edition | Import | Package | Option | OptionName | OptionNameSegment

export type MalformedBase<T extends StatementBase, TType extends string, TKeep extends keyof T> = Pick<
  T,
  TKeep | keyof StatementBase
> &
  Partial<Omit<T, TKeep | keyof StatementBase | "type">> & {
    type: TType
  }

export type Statement =
  | TopLevelStatement
  | MessageBodyStatement
  | EnumBodyStatement
  | ExtendBodyStatement
  | ServiceBodyStatement
  | RpcBodyStatement

export type TopLevelStatement = Syntax | Edition | Import | Package | Option | TopLevelDef | Empty

export type TopLevelDef = Message | Enum | Extend | Service

/**
 * Every statement carries the comment groups buf 1.75 attaches to it (`SourceCodeInfo.Location`; `sweepComments` in ../proto.ts has the rules):
 * - `leadingComments`: at most one group, ending on the line above the statement;
 * - `trailingComments`: at most one group, after the statement's end token (`;`, or the opening `{` of a block);
 * - `leadingDetachedComments`: groups above the leading one, separated by blank lines from the previous declaration and from the statement.
 * The span (`start` / `end`) covers these comments (pbkit behaviour); keyword / name tokens carry exact positions.
 */
export interface StatementBase extends Span {
  leadingComments: CommentGroup[]
  trailingComments: CommentGroup[]
  leadingDetachedComments: CommentGroup[]
}

export interface Syntax extends StatementBase {
  type: "syntax"
  keyword: Keyword
  eq: Token
  quoteOpen: Token
  syntax: Token
  quoteClose: Token
  semi: Semi
}

export interface Edition extends StatementBase {
  type: "edition"
  keyword: Keyword
  eq: Token
  quoteOpen: Token
  edition: Token
  quoteClose: Token
  semi: Semi
}

export interface Import extends StatementBase {
  type: "import"
  keyword: Keyword
  /**
   * Import modifier token: `weak`, `public`, or (addition, edition 2024) `option`. The pbkit field name is kept
   * for compatibility even though `option` is neither weak nor public.
   */
  weakOrPublic?: Token
  strLit: StrLit
  semi: Semi
}

export interface Package extends StatementBase {
  type: "package"
  keyword: Keyword
  fullIdent: FullIdent
  semi: Semi
}

export interface Option extends StatementBase {
  type: "option"
  keyword: Keyword
  optionName: OptionName
  eq: Token
  constant: Constant
  semi: Semi
}

/**
 * `foo.(bar.baz).qux` → segments `foo`, `(bar.baz)`, `qux` separated by `Dot` nodes. A plain segment's
 * `FullIdent` may span several dotted identifiers (`java_package`, `features.field_presence` is one segment), but
 * never ends with a dot: a dot before `(` is a separate `Dot` node (pbkit 0.0.72 folded it into the segment).
 */
export interface OptionName extends Span {
  type: "option-name"
  optionNameSegmentOrDots: (OptionNameSegment | Dot)[]
}

export interface OptionNameSegment extends Span {
  type: "option-name-segment"
  bracketOpen?: Token
  name: FullIdent
  bracketClose?: Token
}
