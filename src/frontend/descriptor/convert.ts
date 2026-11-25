// FileDescriptorSet (ProtoJSON) front end: descriptor protos -> model, SourceCodeInfo -> spans.

import type { BuildIssue, ProtoScalar, ProtoSyntax } from "../../types.ts"
import type {
  MEnum,
  MExtensionRange,
  MField,
  MFile,
  MMessage,
  MOneof,
  MService,
  MTypeRef,
  MWireField,
} from "../../model/index.ts"
import { newEnum, newFile, newHolder, newMessage } from "../../model/index.ts"
import { DESCRIPTOR_SCALAR, DESCRIPTOR_TYPE_BY_NUMBER } from "../../values/scalars.ts"
import { normalizePath, ptr } from "../../paths.ts"
import { unsupportedEdition } from "../../features.ts"
import { editionNameOfNumber, knownSyntaxOfEdition } from "../../common/editions.ts"
import { qualify } from "../../common/names.ts"
import { hasKey, isPlainObject } from "../../common/objects.ts"
import {
  ENUM,
  ENUM_VALUE,
  EXTENSION_RANGE,
  FIELD,
  FILE,
  MESSAGE,
  METHOD,
  ONEOF,
  SERVICE,
} from "../../common/descriptor-fields.ts"
import { type Json, WIRE_OPTIONS, arr, enumStr, get, list, num, str } from "./json.ts"
import {
  ENUM_PARTS,
  FIELD_PARTS,
  FILE_PARTS,
  MESSAGE_PARTS,
  METHOD_PARTS,
  ONEOF_PARTS,
  SERVICE_PARTS,
  SourceIndex,
  VALUE_PARTS,
} from "./source-info.ts"

const LABELS: Record<number, string> = { 1: "LABEL_OPTIONAL", 2: "LABEL_REQUIRED", 3: "LABEL_REPEATED" }

const optionsOf = (o: Json, src: SourceIndex, optionsPath: number[]) => {
  const h = newHolder()
  const opts = get<unknown>(o, "options")
  if (!isPlainObject(opts)) return h
  const wire = (opts as Record<symbol, MWireField[] | undefined>)[WIRE_OPTIONS]
  if (Object.keys(opts).length || wire?.length)
    h.raw.push({ kind: "json", value: opts, locs: src.childLocs(optionsPath), ...(wire?.length ? { wire } : {}) })
  return h
}

const visibilityOf = (o: Json): "export" | "local" | undefined => {
  const v = enumStr(get(o, "visibility"), { 1: "VISIBILITY_LOCAL", 2: "VISIBILITY_EXPORT" })
  return v === "VISIBILITY_LOCAL" ? "local" : v === "VISIBILITY_EXPORT" ? "export" : undefined
}

const inclusive = (ranges: Json[], endExclusive: boolean): [number, number][] =>
  ranges.map((r) => {
    const start = num(r, "start") ?? 0
    const end = num(r, "end") ?? start + 1
    return [start, endExclusive ? end - 1 : end]
  })

interface Ctx {
  src: SourceIndex
  file: MFile
  syntax: ProtoSyntax
}

const convertField = (f: Json, path: number[], ctx: Ctx, entries: Map<string, Json>): MField => {
  const label = enumStr(get(f, "label"), LABELS)
  const typeStr = enumStr(get(f, "type"), DESCRIPTOR_TYPE_BY_NUMBER)
  const typeName = str(f, "typeName")
  let type: MTypeRef
  if (typeStr && hasKey(DESCRIPTOR_SCALAR, typeStr))
    type = { kind: "scalar", scalar: DESCRIPTOR_SCALAR[typeStr] as ProtoScalar }
  else
    type = {
      kind: "named",
      name: typeName ?? "",
      hint:
        typeStr === "TYPE_ENUM"
          ? "enum"
          : typeStr === "TYPE_MESSAGE" || typeStr === "TYPE_GROUP"
            ? "message"
            : undefined,
    }
  const repeated = label === "LABEL_REPEATED"
  const proto3Optional = get<boolean>(f, "proto3Optional") === true
  const field: MField = {
    ...optionsOf(f, ctx.src, [...path, FIELD.options]),
    name: str(f, "name") ?? "",
    number: num(f, "number") ?? 0,
    repeated,
    required: label === "LABEL_REQUIRED",
    optional: ctx.syntax === "proto2" ? label === "LABEL_OPTIONAL" : proto3Optional,
    type,
    group: typeStr === "TYPE_GROUP" || undefined,
    jsonName: str(f, "jsonName"),
    ...ctx.src.element(path, FIELD_PARTS),
  }
  if (!field.locs.type && field.locs.typeKind) field.locs.type = field.locs.typeKind
  delete field.locs.typeKind
  const dv = get(f, "defaultValue")
  if (dv !== undefined) field.default = { kind: "descriptor", value: String(dv) }
  const extendee = str(f, "extendee")
  if (extendee) field.extendee = { name: extendee }
  // map field: repeated message whose type is a nested map entry
  if (repeated && typeName && entries.has(typeName.replace(/^\./, ""))) {
    const entry = entries.get(typeName.replace(/^\./, "")) as Json
    const fields = arr(entry, "field")
    const k = fields.find((x) => num(x, "number") === 1)
    const v = fields.find((x) => num(x, "number") === 2)
    if (k && v) {
      const kt = enumStr(get(k, "type"), DESCRIPTOR_TYPE_BY_NUMBER) ?? ""
      const vt = enumStr(get(v, "type"), DESCRIPTOR_TYPE_BY_NUMBER) ?? ""
      field.map = {
        key: (hasKey(DESCRIPTOR_SCALAR, kt) ? DESCRIPTOR_SCALAR[kt] : undefined) as ProtoScalar,
        value: hasKey(DESCRIPTOR_SCALAR, vt)
          ? { kind: "scalar", scalar: DESCRIPTOR_SCALAR[vt] as ProtoScalar }
          : { kind: "named", name: str(v, "typeName") ?? "", hint: vt === "TYPE_ENUM" ? "enum" : "message" },
      }
      field.repeated = false
    }
  }
  return field
}

const convertEnum = (e: Json, fqn: string, path: number[], ctx: Ctx): MEnum => {
  const out = newEnum(optionsOf(e, ctx.src, [...path, ENUM.options]), str(e, "name") ?? "", fqn, ctx.file, {
    visibility: visibilityOf(e),
    ...ctx.src.element(path, ENUM_PARTS),
  })
  out.values = arr(e, "value").map((v, i) => ({
    ...optionsOf(v, ctx.src, [...path, ENUM.value, i, ENUM_VALUE.options]),
    name: str(v, "name") ?? "",
    number: num(v, "number") ?? 0,
    ...ctx.src.element([...path, ENUM.value, i], VALUE_PARTS),
  }))
  out.reservedRanges = inclusive(arr(e, "reservedRange"), false)
  out.reservedNames = list<string>(e, "reservedName").map(String)
  out.reservedLocs = {
    ranges: arr(e, "reservedRange").map((_, j) => ctx.src.at([...path, ENUM.reservedRange, j])),
    names: list<string>(e, "reservedName").map((_, j) => ctx.src.at([...path, ENUM.reservedName, j])),
  }
  return out
}

const collectEntries = (m: Json, fqn: string, out: Map<string, Json>) => {
  for (const n of arr(m, "nestedType")) {
    const nfqn = `${fqn}.${str(n, "name")}`
    if (get<boolean>(get<Json>(n, "options"), "mapEntry")) out.set(nfqn, n)
    collectEntries(n, nfqn, out)
  }
}

const convertMessage = (m: Json, fqn: string, path: number[], ctx: Ctx, entries: Map<string, Json>): MMessage => {
  const fields = arr(m, "field")
  const oneofDecls = arr(m, "oneofDecl")
  // synthetic oneofs: referenced by proto3 optional fields
  const synthetic = new Set<number>()
  for (const f of fields)
    if (get<boolean>(f, "proto3Optional") === true && num(f, "oneofIndex") !== undefined)
      synthetic.add(num(f, "oneofIndex") as number)
  const oneofs: MOneof[] = []
  const oneofNames = new Map<number, string>()
  oneofDecls.forEach((o, i) => {
    if (synthetic.has(i)) return
    const name = str(o, "name") ?? ""
    oneofNames.set(i, name)
    oneofs.push({
      ...optionsOf(o, ctx.src, [...path, MESSAGE.oneofDecl, i, ONEOF.options]),
      name,
      ...ctx.src.element([...path, MESSAGE.oneofDecl, i], ONEOF_PARTS),
    })
  })
  const msg = newMessage(optionsOf(m, ctx.src, [...path, MESSAGE.options]), str(m, "name") ?? "", fqn, ctx.file, {
    mapEntry: get<boolean>(get<Json>(m, "options"), "mapEntry") === true || undefined,
    visibility: visibilityOf(m),
    ...ctx.src.element(path, MESSAGE_PARTS),
  })
  msg.fields = fields.map((f, i) => {
    const field = convertField(f, [...path, MESSAGE.field, i], ctx, entries)
    const oi = num(f, "oneofIndex")
    if (oi !== undefined && oneofNames.has(oi)) field.oneof = oneofNames.get(oi)
    return field
  })
  msg.oneofs = oneofs
  msg.enums = arr(m, "enumType").map((e, i) =>
    convertEnum(e, `${fqn}.${str(e, "name")}`, [...path, MESSAGE.enumType, i], ctx),
  )
  msg.extensions = arr(m, "extension").map((x, i) => convertField(x, [...path, MESSAGE.extension, i], ctx, entries))
  msg.reservedRanges = inclusive(arr(m, "reservedRange"), true)
  msg.reservedNames = list<string>(m, "reservedName").map(String)
  msg.reservedLocs = {
    ranges: arr(m, "reservedRange").map((_, j) => ctx.src.at([...path, MESSAGE.reservedRange, j])),
    names: list<string>(m, "reservedName").map((_, j) => ctx.src.at([...path, MESSAGE.reservedName, j])),
  }
  msg.extensionRanges = arr(m, "extensionRange").map((r, i): MExtensionRange => {
    const start = num(r, "start") ?? 0
    const rangeLoc = ctx.src.at([...path, MESSAGE.extensionRange, i])
    return {
      ...optionsOf(r, ctx.src, [...path, MESSAGE.extensionRange, i, EXTENSION_RANGE.options]),
      start,
      end: (num(r, "end") ?? start + 1) - 1,
      // the `extensions` statement holding the range (SourceCodeInfo records one location per statement)
      loc: ctx.src.containing([...path, MESSAGE.extensionRange], rangeLoc),
      rangeLoc,
    }
  })
  msg.nested = arr(m, "nestedType").map((n, i) =>
    convertMessage(n, `${fqn}.${str(n, "name")}`, [...path, MESSAGE.nestedType, i], ctx, entries),
  )
  return msg
}

const convertService = (s: Json, fqn: string, path: number[], ctx: Ctx): MService => ({
  ...optionsOf(s, ctx.src, [...path, SERVICE.options]),
  name: str(s, "name") ?? "",
  fqn,
  methods: arr(s, "method").map((m, i) => {
    const mp = [...path, SERVICE.method, i]
    return {
      ...optionsOf(m, ctx.src, [...mp, METHOD.options]),
      name: str(m, "name") ?? "",
      input: { kind: "named", name: str(m, "inputType") ?? "", hint: "message" },
      output: { kind: "named", name: str(m, "outputType") ?? "", hint: "message" },
      clientStreaming: get<boolean>(m, "clientStreaming") === true,
      serverStreaming: get<boolean>(m, "serverStreaming") === true,
      ...ctx.src.element(mp, METHOD_PARTS),
    }
  }),
  ...ctx.src.element(path, SERVICE_PARTS),
  file: ctx.file,
})

/**
 * The syntax of a FileDescriptorProto (spec §3.3). `edition` (a name or a number) decides when `syntax` is "editions" or absent; a known edition maps to its syntax (`EDITION_PROTO3` -> "proto3"), any other is written verbatim without the `EDITION_` prefix (`EDITION_UNSTABLE` -> "UNSTABLE"; a number without a name as its decimal string), and `syntax: "editions"` without an edition is "editions". `unsupported` names what is not known.
 */
export const syntaxOf = (f: Json): { syntax: ProtoSyntax; unsupported?: string } => {
  const syntax = str(f, "syntax")
  if (syntax === "proto3") return { syntax: "proto3" }
  if (syntax !== undefined && syntax !== "" && syntax !== "editions") return { syntax: "proto2" }
  const raw = get(f, "edition")
  const name =
    raw === undefined || raw === null
      ? undefined
      : typeof raw === "number" || /^\d+$/.test(String(raw))
        ? editionNameOfNumber(Number(raw))
        : String(raw)
  if (name === undefined || name === "EDITION_UNKNOWN")
    return syntax === "editions"
      ? { syntax: "editions", unsupported: 'syntax "editions" without an edition' }
      : { syntax: "proto2" }
  const known = knownSyntaxOfEdition(name)
  if (known) return { syntax: known }
  return { syntax: name.startsWith("EDITION_") ? name.slice(8) : name, unsupported: `edition ${name}` }
}

/** Convert one FileDescriptorProto (ProtoJSON) to the model. */
export const convertFile = (f: Json, issues: BuildIssue[]): MFile => {
  const path = normalizePath(str(f, "name") ?? "unnamed.proto")
  const src = new SourceIndex(path, get<Json>(f, "sourceCodeInfo"))
  const { syntax, unsupported } = syntaxOf(f)
  const deps = list<string>(f, "dependency").map((d) => normalizePath(String(d)))
  const publicDeps = new Set(list<number>(f, "publicDependency").map(Number))
  const weakDeps = new Set(list<number>(f, "weakDependency").map(Number))
  const optionDeps = list<string>(f, "optionDependency").map((d) => normalizePath(String(d)))
  const file = newFile(
    optionsOf(f, src, [FILE.options]),
    path,
    syntax,
    str(f, "package") ?? "",
    [
      ...deps.map((d, i) => ({
        path: d,
        flag: publicDeps.has(i) ? ("public" as const) : weakDeps.has(i) ? ("weak" as const) : undefined,
        loc: src.at([FILE.dependency, i]),
      })),
      ...optionDeps.map((d, i) => ({ path: d, flag: "option" as const, loc: src.at([FILE.optionDependency, i]) })),
    ],
    src.element([], FILE_PARTS).locs,
    { isImport: get<boolean>(get<Json>(f, "bufExtension"), "isImport") === true },
  )
  if (!file.locs.syntax && file.locs.edition) file.locs.syntax = file.locs.edition
  delete file.locs.edition
  if (unsupported) issues.push(unsupportedEdition(unsupported, path, ptr(path), file.locs.syntax))
  if (src.empty)
    issues.push({
      code: "no-source-info",
      message: `${path} has no SourceCodeInfo; the source map is empty`,
      file: path,
    })
  // header rule (spec §3.3): the detached comments of the first statement, as the text producer reads them
  const header = src.header()
  if (header.length) file.header = header.join("\n\n")
  const ctx: Ctx = { src, file, syntax }
  const pkg = file.package
  const q = (name: string) => qualify(pkg, name)
  const entries = new Map<string, Json>()
  arr(f, "messageType").forEach((m) => {
    const fqn = q(str(m, "name") ?? "")
    if (get<boolean>(get<Json>(m, "options"), "mapEntry")) entries.set(fqn, m)
    collectEntries(m, fqn, entries)
  })
  file.messages = arr(f, "messageType").map((m, i) =>
    convertMessage(m, q(str(m, "name") ?? ""), [FILE.messageType, i], ctx, entries),
  )
  file.enums = arr(f, "enumType").map((e, i) => convertEnum(e, q(str(e, "name") ?? ""), [FILE.enumType, i], ctx))
  file.services = arr(f, "service").map((s, i) => convertService(s, q(str(s, "name") ?? ""), [FILE.service, i], ctx))
  file.extensions = arr(f, "extension").map((x, i) => convertField(x, [FILE.extension, i], ctx, entries))
  return file
}
