// Binary FileDescriptorSet decoding with the optional peer dependency @bufbuild/protobuf (design §6.1, IN-8).
//
// The set is decoded with `FileDescriptorSetSchema`; custom options arrive as unknown fields and are converted by
// `toJson` with a registry. The registry is built per file from the set plus the bundled definitions (validation
// decision 16), so one file that @bufbuild/protobuf cannot load (a future edition, a missing import) only loses its own
// definitions. Every fallback is reported: `unsupported` when a file's definitions cannot be loaded or decoded,
// `unknown-option` when an option field has no definition anywhere. buf's `ImageFile.buf_extension` (field 8042) is
// read from the unknown fields, so `bufExtension.isImport` survives the binary path (C-3).

import type { BuildIssue, FileDescriptorSetJson, ProtoScalar } from "./types"
import type { MEnum, MField, MFile, MMessage } from "./model"
import { SymbolTable } from "./symbols"
import { linkAll } from "./resolve"
import { DESCRIPTOR_SCALAR, defaultJsonName } from "./values"
import { EDITION_NUMBERS, KNOWN_EDITIONS } from "./features"
import { type VType, decodeWire, scalarType, wireDef } from "./options"

/** The first @bufbuild/protobuf release that supports edition 2024 (the peer dependency minimum). */
export const BUFBUILD_MINIMUM = "2.8.0"
/** The first @bufbuild/protobuf release that supports edition 2026. */
export const BUFBUILD_2026 = "2.16.0"
const VERSION_HINT = `edition 2024 needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}, edition 2026 needs >= ${BUFBUILD_2026}`

/** the optional peer is loaded dynamically and used structurally */
type Any = any

export interface BufbuildModules {
  /** `@bufbuild/protobuf` */
  pb: Any
  /** `@bufbuild/protobuf/wkt` (undefined when the subpath does not exist, as in v1) */
  wkt: Any
}

export interface BinaryContext {
  /** bundled text by import path (the `bundle` option first), undefined when not bundled */
  bundleText: (path: string) => string | undefined
  /** parsed (cached) model of a bundled file */
  bundledFile: (path: string, text: string) => MFile
  issues: BuildIssue[]
}

/** Load @bufbuild/protobuf with a dynamic import; a missing package is an error with a version hint. */
export const loadBufbuild = async (
  importer: (specifier: string) => Promise<Any> = (specifier) => import(/* @vite-ignore */ specifier),
): Promise<BufbuildModules> => {
  const pkg = "@bufbuild/protobuf"
  let pb: Any
  try {
    pb = await importer(pkg)
  } catch {
    throw new Error(
      `the optional peer dependency @bufbuild/protobuf (>= ${BUFBUILD_MINIMUM}) is not installed; install it or pass a \`decoder\``,
    )
  }
  let wkt: Any
  try {
    wkt = await importer(`${pkg}/wkt`)
  } catch {
    wkt = undefined
  }
  return { pb, wkt }
}

const editionName = (n: number): string => {
  for (const [name, num] of Object.entries(EDITION_NUMBERS)) if (num === n) return name
  return String(n)
}
const editionLabel = (n: number): string => {
  const name = editionName(n)
  const known = KNOWN_EDITIONS[name]
  return known ? `edition ${known}` : /^\d+$/.test(name) ? `edition ${name}` : name
}

/** Decode a binary FileDescriptorSet (or buf image) to its ProtoJSON form. Throws when no usable decoder exists. */
export const decodeWithBufbuild = async (
  bytes: Uint8Array,
  ctx: BinaryContext,
  load: () => Promise<BufbuildModules> = loadBufbuild,
): Promise<FileDescriptorSetJson> => {
  const { pb, wkt } = await load()
  if (
    typeof pb?.fromBinary !== "function" ||
    typeof pb?.toJson !== "function" ||
    typeof pb?.createFileRegistry !== "function" ||
    !wkt?.FileDescriptorSetSchema
  )
    throw new Error(
      `the installed @bufbuild/protobuf is not a 2.x release (v1 has no fromBinary / FileDescriptorSetSchema); protoapi needs @bufbuild/protobuf >= ${BUFBUILD_MINIMUM}`,
    )
  const maxEdition: number = typeof pb.maximumEdition === "number" ? pb.maximumEdition : EDITION_NUMBERS.EDITION_2023
  const set = pb.fromBinary(wkt.FileDescriptorSetSchema, bytes)
  const files: Any[] = set.file ?? []
  // read from the bytes: buf_extension, and an edition the decoder's closed `Edition` enum does not know (which
  // @bufbuild/protobuf 2.17 loses when the file also has other unknown fields)
  const raw = scanFileRecords(bytes)
  const rawEdition = new Map<Any, number>()
  files.forEach((fd, i) => {
    const e = raw[i]?.edition
    if (e !== undefined && e !== fd.edition) rawEdition.set(fd, e)
  })
  const registry = buildRegistry(pb, wkt, files, ctx, maxEdition, rawEdition)
  const out: Record<string, unknown>[] = []
  files.forEach((fd, i) => {
    let json: Record<string, unknown>
    try {
      json = pb.toJson(wkt.FileDescriptorProtoSchema, fd, { registry })
    } catch (e) {
      ctx.issues.push({
        code: "unsupported",
        message: `custom options of ${fd.name} cannot be decoded (${(e as Error).message}); they are dropped`,
        file: fd.name,
      })
      json = pb.toJson(wkt.FileDescriptorProtoSchema, fd)
    }
    const ext = raw[i]?.bufExtension
    if (ext) json.bufExtension = ext
    const edition = rawEdition.get(fd)
    if (edition !== undefined) json.edition = edition
    checkUnknownFields(fd, wkt, registry, ctx.issues, maxEdition)
    out.push(json)
  })
  return { file: out }
}

// ---- registry: set + bundle, per file --------------------------------------------------------------------------------

const definesExtensions = (fd: Any): boolean => {
  const inMessage = (m: Any): boolean =>
    (m.extension?.length ?? 0) > 0 || (m.nestedType ?? []).some((n: Any) => inMessage(n))
  return (fd.extension?.length ?? 0) > 0 || (fd.messageType ?? []).some((m: Any) => inMessage(m))
}

const buildRegistry = (
  pb: Any,
  wkt: Any,
  files: Any[],
  ctx: BinaryContext,
  maxEdition: number,
  rawEdition: Map<Any, number>,
): Any => {
  const byName = new Map<string, Any>(files.map((f) => [f.name, f]))
  const bundled = bundledProtos(pb, wkt, files, ctx)
  const descs = new Map<string, Any | null>()
  const reasons = new Map<string, string>()
  const inSet = new Set(byName.keys())
  const fail = (name: string, proto: Any, reason: string, always: boolean) => {
    reasons.set(name, reason)
    if (inSet.has(name) && (always || definesExtensions(proto)))
      ctx.issues.push({
        code: "unsupported",
        message: `the definitions in ${name} cannot be loaded into the @bufbuild/protobuf registry (${reason}); options that use them are not decoded`,
        file: name,
      })
  }
  const visit = (name: string): Any | undefined => {
    if (descs.has(name)) return descs.get(name) ?? undefined
    descs.set(name, null)
    const proto = byName.get(name) ?? bundled.get(name)
    if (!proto) {
      reasons.set(name, "neither in the set nor in the bundle")
      return undefined
    }
    for (const dep of proto.dependency ?? []) visit(dep)
    const edition: number = rawEdition.get(proto) ?? proto.edition
    if (proto.syntax === "editions" && edition > maxEdition && edition !== EDITION_NUMBERS.EDITION_UNSTABLE) {
      const known = KNOWN_EDITIONS[editionName(edition)] !== undefined
      fail(
        name,
        proto,
        `${editionLabel(edition)} is newer than the installed @bufbuild/protobuf supports (up to ${editionLabel(maxEdition)})${known ? `; ${VERSION_HINT}` : ""}`,
        true,
      )
      return undefined
    }
    const missing = (proto.dependency ?? []).find((d: string) => !descs.get(d))
    if (missing) {
      fail(name, proto, `import ${missing} is not available: ${reasons.get(missing) ?? "it cannot be loaded"}`, false)
      return undefined
    }
    try {
      const reg = pb.createFileRegistry(proto, (dep: string) => descs.get(dep) ?? undefined)
      const desc = reg.getFile(name)
      descs.set(name, desc ?? null)
      return desc
    } catch (e) {
      fail(name, proto, (e as Error).message, true)
      return undefined
    }
  }
  for (const f of files) visit(f.name)
  const loaded = [...descs.values()].filter((d) => d)
  return typeof pb.createRegistry === "function" ? pb.createRegistry(...loaded) : pb.createFileRegistry(...loaded)
}

/** FileDescriptorProto messages for bundled files the set imports but does not contain (transitively). */
const bundledProtos = (pb: Any, wkt: Any, files: Any[], ctx: BinaryContext): Map<string, Any> => {
  const out = new Map<string, Any>()
  const inSet = new Set(files.map((f) => f.name as string))
  const wanted = new Set<string>()
  const models = new Map<string, MFile>()
  const queue: string[] = files.flatMap((f) => (f.dependency ?? []) as string[]).filter((d) => !inSet.has(d))
  if (!queue.length || !wkt.FileDescriptorProtoSchema || typeof pb.fromJson !== "function") return out
  for (const q of queue) wanted.add(q)
  // the closure of the wanted bundled files (also the ones the set has, so that names resolve)
  while (queue.length) {
    const path = queue.shift() as string
    if (models.has(path)) continue
    const text = ctx.bundleText(path)
    if (text === undefined) continue
    const model = ctx.bundledFile(path, text)
    models.set(path, model)
    for (const imp of model.imports) {
      if (!inSet.has(imp.path)) wanted.add(imp.path)
      queue.push(imp.path)
    }
  }
  if (!models.size) return out
  const symbols = new SymbolTable([...models.values()])
  linkAll([...models.values()], symbols)
  for (const path of wanted) {
    const model = models.get(path)
    if (!model) continue
    try {
      out.set(path, pb.fromJson(wkt.FileDescriptorProtoSchema, modelToDescriptorJson(model)))
    } catch {
      // not representable: the file stays unavailable and its importers report it
    }
  }
  return out
}

// ---- model -> FileDescriptorProto (ProtoJSON), the parts a registry needs ------------------------------------------

const SCALAR_TYPE: Record<ProtoScalar, string> = Object.fromEntries(
  Object.entries(DESCRIPTOR_SCALAR).map(([k, v]) => [v, k]),
) as Record<ProtoScalar, string>

/** protoc's map entry name: `foo_bar` -> `FooBarEntry` */
const mapEntryName = (field: string): string => {
  let out = ""
  let upper = true
  for (const c of field) {
    if (c === "_") upper = true
    else {
      out += upper ? c.toUpperCase() : c
      upper = false
    }
  }
  return `${out}Entry`
}

const typeJson = (t: MField["type"]): Record<string, unknown> => {
  if (t.kind === "scalar") return { type: SCALAR_TYPE[t.scalar] }
  const r = t.resolved
  return {
    type: r?.kind === "enum" ? "TYPE_ENUM" : "TYPE_MESSAGE",
    typeName: `.${r?.fqn ?? t.name.replace(/^\./, "")}`,
  }
}

const syntaxJson = (file: MFile): Record<string, unknown> => {
  if (file.syntax === "proto2") return {}
  if (file.syntax === "proto3") return { syntax: "proto3" }
  const name = Object.entries(KNOWN_EDITIONS).find(([, v]) => v === file.syntax)?.[0]
  return { syntax: "editions", edition: name ?? "EDITION_UNKNOWN" }
}

const enumJson = (e: MEnum) => ({ name: e.name, value: e.values.map((v) => ({ name: v.name, number: v.number })) })

const fieldJson = (f: MField, file: MFile, oneofIndex: Map<string, number>, typeOverride?: Record<string, unknown>) => {
  const out: Record<string, unknown> = {
    name: f.name,
    number: f.number,
    label: f.repeated || f.map ? "LABEL_REPEATED" : f.required ? "LABEL_REQUIRED" : "LABEL_OPTIONAL",
    ...(typeOverride ?? typeJson(f.type)),
  }
  if (f.group && f.type.kind === "named") out.type = "TYPE_GROUP"
  if (f.extendee) out.extendee = `.${f.extendee.resolved ?? f.extendee.name.replace(/^\./, "")}`
  if (f.oneof !== undefined && oneofIndex.has(f.oneof)) out.oneofIndex = oneofIndex.get(f.oneof)
  // protoc always writes json_name; @bufbuild/protobuf uses it as the JSON key
  out.jsonName = f.jsonName ?? defaultJsonName(f.name)
  if (file.syntax === "proto3" && f.optional && !f.repeated && !f.map) out.proto3Optional = true
  return out
}

const messageJson = (m: MMessage, file: MFile): Record<string, unknown> => {
  const oneofs = m.oneofs.map((o) => ({ name: o.name }))
  const oneofIndex = new Map(m.oneofs.map((o, i) => [o.name, i]))
  const nested: Record<string, unknown>[] = m.nested.filter((n) => !n.mapEntry).map((n) => messageJson(n, file))
  const fields = m.fields.map((f) => {
    if (f.map) {
      const entry = mapEntryName(f.name)
      const value = f.map.value
      nested.push({
        name: entry,
        field: [
          { name: "key", number: 1, label: "LABEL_OPTIONAL", type: SCALAR_TYPE[f.map.key], jsonName: "key" },
          { name: "value", number: 2, label: "LABEL_OPTIONAL", ...typeJson(value), jsonName: "value" },
        ],
        options: { mapEntry: true },
      })
      return fieldJson(f, file, oneofIndex, { type: "TYPE_MESSAGE", typeName: `.${m.fqn}.${entry}` })
    }
    const json = fieldJson(f, file, oneofIndex)
    if (json.proto3Optional) {
      json.oneofIndex = oneofs.length
      oneofs.push({ name: `_${f.name}` })
    }
    return json
  })
  return {
    name: m.name,
    field: fields,
    nestedType: nested,
    enumType: m.enums.map(enumJson),
    extension: m.extensions.map((x) => fieldJson(x, file, new Map())),
    extensionRange: m.extensionRanges.map((r) => ({ start: r.start, end: r.end + 1 })),
    oneofDecl: oneofs,
  }
}

/** The structure of a parsed (and linked) file as a ProtoJSON FileDescriptorProto: types, fields, extensions. */
export const modelToDescriptorJson = (file: MFile): Record<string, unknown> => {
  const deps = file.imports.filter((i) => i.flag !== "option")
  return {
    name: file.path,
    ...(file.package ? { package: file.package } : {}),
    dependency: deps.map((i) => i.path),
    publicDependency: deps.flatMap((i, k) => (i.flag === "public" ? [k] : [])),
    weakDependency: deps.flatMap((i, k) => (i.flag === "weak" ? [k] : [])),
    messageType: file.messages.map((m) => messageJson(m, file)),
    enumType: file.enums.map(enumJson),
    extension: file.extensions.map((x) => fieldJson(x, file, new Map())),
    ...syntaxJson(file),
  }
}

// ---- unknown fields ----------------------------------------------------------------------------------------------------

interface Unknown {
  no: number
  wireType: number
  data: Uint8Array
}

/** buf's `ImageFileExtension` (`buf_extension`, 8042), in buf's JSON names. */
const BUF_EXTENSION = wireDef([
  [1, "isImport", scalarType("bool")],
  [3, "isSyntaxUnspecified", scalarType("bool")],
  [4, "unusedDependency", scalarType("int32"), true],
])
const message = (def: MMessage): VType => ({ kind: "message", def })
const FILE_RECORDS = wireDef([
  [
    1,
    "file",
    message(
      wireDef([
        [14, "edition", scalarType("int32")],
        [8042, "bufExtension", message(BUF_EXTENSION)],
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
export const readBufExtension = (unknown: Unknown[] | undefined): Record<string, unknown> | undefined => {
  const field = unknown?.find((u) => u.no === 8042 && u.wireType === 2)
  try {
    return (
      field &&
      (decodeWire(Uint8Array.of(10, ...field.data), wireDef([[1, "x", message(BUF_EXTENSION)]]), undefined as never)
        .x as never)
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
const checkUnknownFields = (fd: Any, wkt: Any, registry: Any, issues: BuildIssue[], maxEdition: number) => {
  const file = String(fd.name ?? "")
  const unknownOptions = new Map<string, Set<number>>()
  const unknownDescriptor = new Map<string, Set<number>>()
  const add = (m: Map<string, Set<number>>, key: string, no: number) => {
    let s = m.get(key)
    if (!s) m.set(key, (s = new Set()))
    s.add(no)
  }
  const options = (o: Any, kind: string) => {
    if (!o?.$unknown) return
    const schema = wkt[OPTION_SCHEMAS[kind]]
    for (const u of o.$unknown as Unknown[])
      if (!schema || !registry.getExtensionFor?.(schema, u.no)) add(unknownOptions, schema?.typeName ?? kind, u.no)
  }
  const descriptor = (d: Any, typeName: string, skip: number[] = []) => {
    for (const u of (d?.$unknown ?? []) as Unknown[]) if (!skip.includes(u.no)) add(unknownDescriptor, typeName, u.no)
  }
  const field = (f: Any) => {
    descriptor(f, "google.protobuf.FieldDescriptorProto")
    options(f.options, "field")
  }
  const enumeration = (e: Any) => {
    descriptor(e, "google.protobuf.EnumDescriptorProto")
    options(e.options, "enum")
    for (const v of e.value ?? []) {
      descriptor(v, "google.protobuf.EnumValueDescriptorProto")
      options(v.options, "enumValue")
    }
  }
  const message = (m: Any) => {
    descriptor(m, "google.protobuf.DescriptorProto")
    options(m.options, "message")
    for (const f of m.field ?? []) field(f)
    for (const x of m.extension ?? []) field(x)
    for (const o of m.oneofDecl ?? []) options(o.options, "oneof")
    for (const r of m.extensionRange ?? []) options(r.options, "extensionRange")
    for (const n of m.nestedType ?? []) message(n)
    for (const e of m.enumType ?? []) enumeration(e)
  }
  // 8042: buf_extension; 14: an edition value the decoder does not know (both are read above)
  descriptor(fd, "google.protobuf.FileDescriptorProto", [8042, 14])
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
