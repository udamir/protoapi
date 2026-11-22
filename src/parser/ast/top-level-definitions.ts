/**
 * Origin: pbkit 0.0.72, `core/ast/top-level-definitions.d.ts` (https://github.com/pbkit/pbkit),
 * Copyright (c) JongChan Choi. Licence: MIT OR Apache-2.0 (see ./../LICENSE-MIT, ./../LICENSE-APACHE).
 *
 * Modifications:
 * - reconstructed as TypeScript source from the published `.d.ts`; type-only imports.
 * - `Message.visibility` and `Enum.visibility` added (edition 2024 `export` / `local`).
 * - doc comments: for block statements (`message`, `enum`, `extend`, `service`, `rpc` with a body, `oneof`,
 *   `group`) `trailingComments` are the comments after the opening `{`, as in protoc; comments after the closing
 *   `}` are not attached (pbkit attached those instead).
 */
import type { Span, Token } from "../recursive-descent-parser.ts"
import type { Extensions, Reserved } from "./extensions-and-reserved.ts"
import type { Field, FieldOptions, Group, MalformedField, MapField, Oneof } from "./fields.ts"
import type { Option, StatementBase } from "./index.ts"
import type { Empty, Keyword, Semi, SignedIntLit, Type } from "./lexical-elements.ts"

export type Node =
  | Enum
  | EnumBody
  | EnumField
  | Message
  | MessageBody
  | Extend
  | ExtendBody
  | Service
  | ServiceBody
  | Rpc
  | RpcBody

export interface Enum extends StatementBase {
  type: "enum"
  /** Addition (not in pbkit 0.0.72): edition 2024 symbol visibility, keyword text `export` or `local`. */
  visibility?: Keyword
  keyword: Keyword
  enumName: Token
  enumBody: EnumBody
}

export interface EnumBody extends Span {
  type: "enum-body"
  bracketOpen: Token
  statements: EnumBodyStatement[]
  bracketClose: Token
}

export type EnumBodyStatement = Option | Reserved | EnumField | Empty

export interface EnumField extends StatementBase {
  type: "enum-field"
  fieldName: Token
  eq: Token
  fieldNumber: SignedIntLit
  fieldOptions?: FieldOptions
  semi: Semi
}

export interface Message extends StatementBase {
  type: "message"
  /** Addition (not in pbkit 0.0.72): edition 2024 symbol visibility, keyword text `export` or `local`. */
  visibility?: Keyword
  keyword: Keyword
  messageName: Token
  messageBody: MessageBody
}

export interface MessageBody extends Span {
  type: "message-body"
  bracketOpen: Token
  statements: MessageBodyStatement[]
  bracketClose: Token
}

export type MessageBodyStatement =
  | Field
  | MalformedField
  | Enum
  | Message
  | Extend
  | Extensions
  | Group
  | Option
  | Oneof
  | MapField
  | Reserved
  | Empty

export interface Extend extends StatementBase {
  type: "extend"
  keyword: Keyword
  messageType: Type
  extendBody: ExtendBody
}

export interface ExtendBody extends Span {
  type: "extend-body"
  bracketOpen: Token
  statements: ExtendBodyStatement[]
  bracketClose: Token
}

export type ExtendBodyStatement = Field | MalformedField | Group | Empty

export interface Service extends StatementBase {
  type: "service"
  keyword: Keyword
  serviceName: Token
  serviceBody: ServiceBody
}

export interface ServiceBody extends Span {
  type: "service-body"
  bracketOpen: Token
  statements: ServiceBodyStatement[]
  bracketClose: Token
}

export type ServiceBodyStatement = Option | Rpc | Empty

export interface Rpc extends StatementBase {
  type: "rpc"
  keyword: Keyword
  rpcName: Token
  reqType: RpcType
  returns: Keyword
  resType: RpcType
  semiOrRpcBody: Semi | RpcBody
}

export interface RpcBody extends Span {
  type: "rpc-body"
  bracketOpen: Token
  statements: RpcBodyStatement[]
  bracketClose: Token
}

export type RpcBodyStatement = Option | Empty

export interface RpcType extends Span {
  bracketOpen: Token
  stream?: Keyword
  messageType: Type
  bracketClose: Token
}
