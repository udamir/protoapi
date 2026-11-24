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
  type FieldProto,
  type FileProto,
  type MessageProto,
  type UnknownField,
  VERSION_HINT,
  type WithUnknown,
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

const OPTION_SCHEMAS: Record<string, string> = {
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
  const options = (o: WithUnknown | undefined, kind: string) => {
    if (!o?.$unknown) return
    const schema = wkt[OPTION_SCHEMAS[kind]]
    for (const u of o.$unknown)
      if (!schema || !registry.getExtensionFor?.(schema, u.no)) add(unknownOptions, schema?.typeName ?? kind, u.no)
  }
  const descriptor = (d: WithUnknown | undefined, typeName: string, skip: number[] = []) => {
    for (const u of d?.$unknown ?? []) if (!skip.includes(u.no)) add(unknownDescriptor, typeName, u.no)
  }
  const field = (f: FieldProto) => {
    descriptor(f, "google.protobuf.FieldDescriptorProto")
    options(f.options, "field")
  }
  const enumeration = (e: EnumProto) => {
    descriptor(e, "google.protobuf.EnumDescriptorProto")
    options(e.options, "enum")
    for (const v of e.value ?? []) {
      descriptor(v, "google.protobuf.EnumValueDescriptorProto")
      options(v.options, "enumValue")
    }
  }
  const message = (m: MessageProto) => {
    descriptor(m, "google.protobuf.DescriptorProto")
    options(m.options, "message")
    for (const f of m.field ?? []) field(f)
    for (const x of m.extension ?? []) field(x)
    for (const o of m.oneofDecl ?? []) options(o.options, "oneof")
    for (const r of m.extensionRange ?? []) options(r.options, "extensionRange")
    for (const n of m.nestedType ?? []) message(n)
    for (const e of m.enumType ?? []) enumeration(e)
  }
  // buf_extension and an edition value the decoder does not know (both are read from the bytes, `scanFileRecords`)
  descriptor(fd, "google.protobuf.FileDescriptorProto", [BUF_EXTENSION_FIELD, FILE.edition])
  options(fd.options, "file")
  for (const m of fd.messageType ?? []) message(m)
  for (const e of fd.enumType ?? []) enumeration(e)
  for (const x of fd.extension ?? []) field(x)
  for (const s of fd.service ?? []) {
    descriptor(s, "google.protobuf.ServiceDescriptorProto")
    options(s.options, "service")
    for (const m of s.method ?? []) {
      descriptor(m, "google.protobuf.MethodDescriptorProto")
      options(m.options, "method")
    }
  }
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
