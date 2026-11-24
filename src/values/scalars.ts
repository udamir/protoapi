// Protobuf scalar types: their names and groups, the wrapper well-known types, and the descriptor `Type` enum.

import type { ProtoScalar } from "../types.ts"

export const INT64_KINDS = new Set<ProtoScalar>(["int64", "uint64", "sint64", "fixed64", "sfixed64"])
export const INT32_KINDS = new Set<ProtoScalar>(["int32", "uint32", "sint32", "fixed32", "sfixed32"])
export const FLOAT_KINDS = new Set<ProtoScalar>(["float", "double"])

export const SCALARS = new Set<string>([
  "double",
  "float",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "bool",
  "string",
  "bytes",
])

export const isScalar = (name: string): name is ProtoScalar => SCALARS.has(name)

/** Wrapper well-known types and their scalar (`google.protobuf.StringValue` -> `string`). */
export const WRAPPERS: Record<string, ProtoScalar> = {
  "google.protobuf.DoubleValue": "double",
  "google.protobuf.FloatValue": "float",
  "google.protobuf.Int64Value": "int64",
  "google.protobuf.UInt64Value": "uint64",
  "google.protobuf.Int32Value": "int32",
  "google.protobuf.UInt32Value": "uint32",
  "google.protobuf.BoolValue": "bool",
  "google.protobuf.StringValue": "string",
  "google.protobuf.BytesValue": "bytes",
}

/** descriptor FieldDescriptorProto.Type -> scalar name */
export const DESCRIPTOR_SCALAR: Record<string, ProtoScalar> = {
  TYPE_DOUBLE: "double",
  TYPE_FLOAT: "float",
  TYPE_INT64: "int64",
  TYPE_UINT64: "uint64",
  TYPE_INT32: "int32",
  TYPE_FIXED64: "fixed64",
  TYPE_FIXED32: "fixed32",
  TYPE_BOOL: "bool",
  TYPE_STRING: "string",
  TYPE_BYTES: "bytes",
  TYPE_UINT32: "uint32",
  TYPE_SFIXED32: "sfixed32",
  TYPE_SFIXED64: "sfixed64",
  TYPE_SINT32: "sint32",
  TYPE_SINT64: "sint64",
}
/** descriptor type numbers (binary / numeric enum form) */
export const DESCRIPTOR_TYPE_BY_NUMBER: Record<number, string> = {
  1: "TYPE_DOUBLE",
  2: "TYPE_FLOAT",
  3: "TYPE_INT64",
  4: "TYPE_UINT64",
  5: "TYPE_INT32",
  6: "TYPE_FIXED64",
  7: "TYPE_FIXED32",
  8: "TYPE_BOOL",
  9: "TYPE_STRING",
  10: "TYPE_GROUP",
  11: "TYPE_MESSAGE",
  12: "TYPE_BYTES",
  13: "TYPE_UINT32",
  14: "TYPE_ENUM",
  15: "TYPE_SFIXED32",
  16: "TYPE_SFIXED64",
  17: "TYPE_SINT32",
  18: "TYPE_SINT64",
}
