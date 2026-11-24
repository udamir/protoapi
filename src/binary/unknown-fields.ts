// Fields of a binary FileDescriptorSet that @bufbuild/protobuf does not decode: buf's `ImageFile.buf_extension` and
// raw edition numbers read from the bytes, and the report of option / descriptor fields left unknown.

import type { BuildIssue } from "../types.ts"
import type { MMessage } from "../model/index.ts"
import type { VType } from "../options/scalar.ts"
import { FILE, FILE_SET } from "../common/descriptor-fields.ts"
import { decodeWire, scalarType, wireDef } from "../wire.ts"
import {
  type Any,
  type EnumProto,
  type FileProto,
  type MessageProto,
  type ServiceProto,
  type UnknownField,
  VERSION_HINT,
  type WithOptions,
  editionLabel,
} from "./bufbuild.ts"

/** buf's `ImageFile.buf_extension`: the field number of its `ImageFileExtension` on a buf image's files. */
const BUF_EXTENSION_FIELD = 8042
/** The wire type of a length-delimited field (a message, bytes or a string). */
const LENGTH_DELIMITED = 2

/** buf's `ImageFileExtension` (`buf_extension`, 8042), in buf's JSON names. */
const BUF_EXTENSION = wireDef([
  [1, "isImport", scalarType("bool")],
  [3, "isSyntaxUnspecified", scalarType("bool")],
  [4, "unusedDependency", scalarType("int32"), true],
])
const message = (def: MMessage): VType => ({ kind: "message", def })
const FILE_RECORDS = wireDef([
  [
    FILE_SET.file,
    "file",
    message(
      wireDef([
        [FILE.edition, "edition", scalarType("int32")],
        [BUF_EXTENSION_FIELD, "bufExtension", message(BUF_EXTENSION)],
      ]),
    ),
    true,
  ],
])

/** Per `file` record of a FileDescriptorSet (or buf Image): the last `edition` (14) value and the `buf_extension` (8042), read from the bytes. Empty when the bytes cannot be read. */
export const scanFileRecords = (b: Uint8Array): { edition?: number; bufExtension?: Record<string, unknown> }[] => {
  try {
    return (decodeWire(b, FILE_RECORDS, undefined as never).file ?? []) as never
  } catch {
    return []
  }
}

/** buf's `ImageFile.buf_extension` (8042) from @bufbuild/protobuf unknown fields (length-prefixed). */
export const readBufExtension = (unknown: UnknownField[] | undefined): Record<string, unknown> | undefined => {
  const field = unknown?.find((u) => u.no === BUF_EXTENSION_FIELD && u.wireType === LENGTH_DELIMITED)
  try {
    return (
      field &&
      (decodeWire(
        // the data as field 1 of a wrapper message
        Uint8Array.of((1 << 3) | LENGTH_DELIMITED, ...field.data),
        wireDef([[1, "x", message(BUF_EXTENSION)]]),
        undefined as never,
      ).x as never)
    )
  } catch {
    return undefined
  }
}

/** The `@bufbuild/protobuf/wkt` schema of each kind of `*Options` message. */
export const OPTION_SCHEMAS: Record<string, string> = {
  file: "FileOptionsSchema",
  message: "MessageOptionsSchema",
  field: "FieldOptionsSchema",
  oneof: "OneofOptionsSchema",
  enum: "EnumOptionsSchema",
  enumValue: "EnumValueOptionsSchema",
  service: "ServiceOptionsSchema",
  method: "MethodOptionsSchema",
  extensionRange: "ExtensionRangeOptionsSchema",
}

/** The descriptor message of each kind of element whose own unknown fields are reported (oneofs and extension ranges are not). */
const DESCRIPTOR_TYPES: Record<string, string> = {
  file: "google.protobuf.FileDescriptorProto",
  message: "google.protobuf.DescriptorProto",
  field: "google.protobuf.FieldDescriptorProto",
  enum: "google.protobuf.EnumDescriptorProto",
  enumValue: "google.protobuf.EnumValueDescriptorProto",
  service: "google.protobuf.ServiceDescriptorProto",
  method: "google.protobuf.MethodDescriptorProto",
}

type Json = Record<string, unknown>

/** Visit every element of a file in declaration order (an element before its children) with the kind of its options message (`OPTION_SCHEMAS`), and with its ProtoJSON object when the file's ProtoJSON `json` is given (walked in parallel). */
export const eachElement = (
  fd: FileProto,
  json: Json | undefined,
  visit: (d: WithOptions, kind: string, j: Json | undefined) => void,
) => {
  const each = <T extends WithOptions>(
    list: T[] | undefined,
    j: Json | undefined,
    key: string,
    kind: string,
    inner?: (d: T, j: Json | undefined) => void,
  ) =>
    list?.forEach((d, i) => {
      const dj = j && Array.isArray(j[key]) ? (j[key] as Json[])[i] : undefined
      visit(d, kind, dj)
      inner?.(d, dj)
    })
  const enumeration = (e: EnumProto, j: Json | undefined) => each(e.value, j, "value", "enumValue")
  const message = (m: MessageProto, j: Json | undefined) => {
    each(m.field, j, "field", "field")
    each(m.extension, j, "extension", "field")
    each(m.oneofDecl, j, "oneofDecl", "oneof")
    each(m.extensionRange, j, "extensionRange", "extensionRange")
    each(m.nestedType, j, "nestedType", "message", message)
    each(m.enumType, j, "enumType", "enum", enumeration)
  }
  visit(fd, "file", json)
  each(fd.messageType, json, "messageType", "message", message)
  each(fd.enumType, json, "enumType", "enum", enumeration)
  each(fd.extension, json, "extension", "field")
  each(fd.service, json, "service", "service", (s: ServiceProto, j) => each(s.method, j, "method", "method"))
}

/** Report option fields without a definition (`unknown-option`) and descriptor fields the decoder does not know. */
export const checkUnknownFields = (
  fd: FileProto,
  wkt: Any,
  registry: Any,
  issues: BuildIssue[],
  maxEdition: number,
) => {
  const file = String(fd.name ?? "")
  const unknownOptions = new Map<string, Set<number>>()
  const unknownDescriptor = new Map<string, Set<number>>()
  const add = (m: Map<string, Set<number>>, key: string, no: number) => {
    let s = m.get(key)
    if (!s) m.set(key, (s = new Set()))
    s.add(no)
  }
  eachElement(fd, undefined, (d, kind) => {
    const typeName = DESCRIPTOR_TYPES[kind]
    // buf_extension and an edition value the decoder does not know (both are read from the bytes, `scanFileRecords`)
    const skip = kind === "file" ? [BUF_EXTENSION_FIELD, FILE.edition] : []
    if (typeName) for (const u of d.$unknown ?? []) if (!skip.includes(u.no)) add(unknownDescriptor, typeName, u.no)
    const schema = wkt[OPTION_SCHEMAS[kind]]
    for (const u of d.options?.$unknown ?? [])
      if (!schema || !registry.getExtensionFor?.(schema, u.no)) add(unknownOptions, schema?.typeName ?? kind, u.no)
  })
  for (const [typeName, nos] of unknownOptions)
    issues.push({
      code: "unknown-option",
      message: `option field number${nos.size > 1 ? "s" : ""} ${[...nos].join(", ")} of ${typeName} in ${file} cannot be decoded: no extension definition in the set or the bundle; the value is dropped`,
      file,
    })
  for (const [typeName, nos] of unknownDescriptor)
    issues.push({
      code: "unsupported",
      message: `field number${nos.size > 1 ? "s" : ""} ${[...nos].join(", ")} of ${typeName} in ${file} ${nos.size > 1 ? "are" : "is"} unknown to the installed @bufbuild/protobuf (up to ${editionLabel(maxEdition)}) and dropped; ${VERSION_HINT}`,
      file,
    })
}
