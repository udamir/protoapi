// FileDescriptorSet (ProtoJSON) front end (design §6): descriptor protos -> model, SourceCodeInfo -> spans.

import type { BuildIssue, Location, ProtoScalar, ProtoSyntax } from "./types.ts"
import type {
  Locs,
  MComments,
  MEnum,
  MExtensionRange,
  MField,
  MFile,
  MMessage,
  MOneof,
  MService,
  MTypeRef,
} from "./model.ts"
import { newHolder } from "./model.ts"
import { DESCRIPTOR_SCALAR, DESCRIPTOR_TYPE_BY_NUMBER } from "./values.ts"
import { normalizePath, ptr } from "./paths.ts"
import { EDITION_NUMBERS, KNOWN_EDITIONS, unsupportedEdition } from "./features.ts"

type Json = Record<string, unknown>

/** Read a ProtoJSON field by lowerCamelCase or snake_case name. */
const snakeCache = new Map<string, string>()
const get = <T = unknown>(o: Json | undefined, camel: string): T | undefined => {
  if (!o) return undefined
  const v = o[camel]
  if (v !== undefined) return v as T
  let snake = snakeCache.get(camel)
  if (snake === undefined) snakeCache.set(camel, (snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)))
  return snake === camel ? undefined : (o[snake] as T | undefined)
}
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const arr = (o: Json | undefined, camel: string): Json[] => {
  const v = get<unknown>(o, camel)
  return Array.isArray(v) ? (v.filter(isObj) as Json[]) : []
}
const list = <T>(o: Json | undefined, camel: string): T[] => {
  const v = get<unknown>(o, camel)
  return Array.isArray(v) ? (v.filter((x) => x !== null && typeof x !== "object") as T[]) : []
}
/** The numbers of a list (a path or a span), without the filter and map passes of `list`. */
const numbers = (v: unknown): number[] => {
  const out: number[] = []
  if (Array.isArray(v)) for (const x of v) if (x !== null && typeof x !== "object") out.push(Number(x))
  return out
}
const str = (o: Json | undefined, camel: string): string | undefined => {
  const v = get(o, camel)
  return v === undefined ? undefined : String(v)
}
const num = (o: Json | undefined, camel: string): number | undefined => {
  const v = get(o, camel)
  return v === undefined ? undefined : Number(v)
}
const enumStr = (v: unknown, byNumber?: Record<number, string>): string | undefined =>
  v === undefined ? undefined : typeof v === "number" ? (byNumber?.[v] ?? String(v)) : String(v)

const LABELS: Record<number, string> = { 1: "LABEL_OPTIONAL", 2: "LABEL_REQUIRED", 3: "LABEL_REPEATED" }
const EDITION_BY_NUMBER: Record<number, string> = Object.fromEntries(
  Object.entries(EDITION_NUMBERS).map(([name, n]) => [n, name]),
)

// ---- SourceCodeInfo index -------------------------------------------------------------------------------------------

/** A `SourceCodeInfo.Location` as given (ProtoJSON); its span and comments are read when an element asks for them. */
type SciLocation = Json

interface TrieNode {
  /** location whose path ends here (first one wins) */
  loc?: SciLocation
  /** every location whose path ends here (statements written more than once: `extensions`, `reserved`) */
  all?: SciLocation[]
  /** first location anywhere in the subtree */
  first?: SciLocation
  kids?: Map<number, TrieNode>
}

const spanOf = (l: SciLocation): number[] => numbers(get(l, "span"))
const detachedOf = (l: SciLocation | undefined): string[] => list<string>(l, "leadingDetachedComments").map(String)

class SourceIndex {
  private readonly root: TrieNode = {}
  private readonly locations: SciLocation[]
  private readonly file: string

  constructor(file: string, info: Json | undefined) {
    this.file = file
    this.locations = arr(info, "location")
    // locations come in tree order: the trie nodes of the previous path's common prefix are reused
    const chain: TrieNode[] = [this.root]
    let prev: number[] = []
    for (const l of this.locations) {
      const path = numbers(get(l, "path"))
      let k = 0
      while (k < path.length && k < prev.length && path[k] === prev[k]) k++
      let node = chain[k]
      node.first ??= l
      for (; k < path.length; k++) {
        const kids: Map<number, TrieNode> = (node.kids ??= new Map())
        let next = kids.get(path[k])
        if (!next) kids.set(path[k], (next = { first: l }))
        node = next
        chain[k + 1] = node
      }
      if (!node.loc) node.loc = l
      else (node.all ??= [node.loc]).push(l)
      prev = path
    }
  }

  get empty() {
    return this.locations.length === 0
  }

  /** The detached comments of the file header (§3.3, C-12): those of `syntax` / `edition`, else of the location that starts first in the file, preferring one with detached comments. */
  header(): string[] {
    let first = this.node([12])?.loc ?? this.node([14])?.loc
    if (!first) {
      let fs: number[] = []
      for (const l of this.locations) {
        const span = spanOf(l)
        if (!numbers(get(l, "path")).length || span.length < 3) continue
        const cmp = first ? span[0] - fs[0] || span[1] - fs[1] : -1
        if (cmp < 0 || (cmp === 0 && !detachedOf(first).length && detachedOf(l).length)) {
          first = l
          fs = span
        }
      }
    }
    return detachedOf(first)
  }

  private node(path: number[]): TrieNode | undefined {
    let node: TrieNode | undefined = this.root
    for (let k = 0; k < path.length && node; k++) node = node.kids?.get(path[k])
    return node
  }

  location(l: SciLocation | undefined): Location | undefined {
    if (!l) return undefined
    const span = spanOf(l)
    if (span.length < 3) return undefined
    const line = span[0]
    const column = span[1]
    const endLine = span.length === 3 ? line : span[2]
    const endColumn = span.length === 3 ? span[2] : span[3]
    return { file: this.file, start: { line, column }, end: { line: endLine, column: endColumn } }
  }

  /** Comments and locations of an element and of its parts (child field numbers), in one trie walk. */
  element(path: number[], parts: Parts): { comments: MComments; locs: Locs } {
    const locs: Locs = {}
    const node = this.node(path)
    const l = node?.loc
    const self = this.location(l)
    if (self) locs[""] = self
    if (node?.kids) {
      for (const k in parts) {
        const at = this.location(node.kids.get(parts[k])?.loc)
        if (at) locs[k] = at
      }
    }
    return { comments: { leading: str(l, "leadingComments"), trailing: str(l, "trailingComments") }, locs }
  }

  at(path: number[]): Location | undefined {
    return this.location(this.node(path)?.loc)
  }

  /** The location at `path` (a statement written more than once) whose span contains `inner`. */
  containing(path: number[], inner: Location | undefined): Location | undefined {
    const node = this.node(path)
    if (!node || !inner) return this.location(node?.loc)
    const before = (a: { line: number; column: number }, b: { line: number; column: number }) =>
      a.line < b.line || (a.line === b.line && a.column <= b.column)
    for (const l of node.all ?? (node.loc ? [node.loc] : [])) {
      const loc = this.location(l)
      if (loc && before(loc.start, inner.start) && before(inner.end, loc.end)) return loc
    }
    return this.location(node.loc)
  }

  /** Location of the first statement under `path` for each child number (option statements). */
  childLocs(path: number[]): Record<string, Location> {
    const out: Record<string, Location> = {}
    const kids = this.node(path)?.kids
    if (!kids) return out
    for (const [n, kid] of kids) {
      const loc = this.location(kid.loc ?? kid.first)
      if (loc) out[String(n)] = loc
    }
    return out
  }
}

/** Parts of an element: location key -> child field number of its descriptor. */
type Parts = Record<string, number>
const FIELD_PARTS: Parts = { name: 1, extendee: 2, number: 3, label: 4, typeKind: 5, type: 6, default: 7, jsonName: 10 }
const NAME_PART: Parts = { name: 1 }
const VALUE_PARTS: Parts = { name: 1, number: 2 }
const ENUM_PARTS: Parts = { name: 1, reserved: 4, reservedNames: 5 }
const MESSAGE_PARTS: Parts = { name: 1, extensions: 5, reserved: 9, reservedNames: 10 }
const METHOD_PARTS: Parts = { name: 1, request: 2, response: 3, "request/stream": 5, "response/stream": 6 }
const FILE_PARTS: Parts = { syntax: 12, package: 2, edition: 14 }

// ---- conversion -------------------------------------------------------------------------------------------------------

const optionsOf = (o: Json, src: SourceIndex, optionsPath: number[]) => {
  const h = newHolder()
  const opts = get<unknown>(o, "options")
  if (isObj(opts) && Object.keys(opts).length)
    h.raw.push({ kind: "json", value: opts, locs: src.childLocs(optionsPath) })
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
  if (typeStr && typeStr in DESCRIPTOR_SCALAR)
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
    ...optionsOf(f, ctx.src, [...path, 8]),
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
        key: DESCRIPTOR_SCALAR[kt] as ProtoScalar,
        value:
          vt in DESCRIPTOR_SCALAR
            ? { kind: "scalar", scalar: DESCRIPTOR_SCALAR[vt] as ProtoScalar }
            : { kind: "named", name: str(v, "typeName") ?? "", hint: vt === "TYPE_ENUM" ? "enum" : "message" },
      }
      field.repeated = false
    }
  }
  return field
}

const convertEnum = (e: Json, fqn: string, path: number[], ctx: Ctx): MEnum => ({
  ...optionsOf(e, ctx.src, [...path, 3]),
  name: str(e, "name") ?? "",
  fqn,
  values: arr(e, "value").map((v, i) => ({
    ...optionsOf(v, ctx.src, [...path, 2, i, 3]),
    name: str(v, "name") ?? "",
    number: num(v, "number") ?? 0,
    ...ctx.src.element([...path, 2, i], VALUE_PARTS),
  })),
  reservedRanges: inclusive(arr(e, "reservedRange"), false),
  reservedNames: list<string>(e, "reservedName").map(String),
  reservedLocs: {
    ranges: arr(e, "reservedRange").map((_, j) => ctx.src.at([...path, 4, j])),
    names: list<string>(e, "reservedName").map((_, j) => ctx.src.at([...path, 5, j])),
  },
  visibility: visibilityOf(e),
  ...ctx.src.element(path, ENUM_PARTS),
  file: ctx.file,
})

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
      ...optionsOf(o, ctx.src, [...path, 8, i, 2]),
      name,
      ...ctx.src.element([...path, 8, i], NAME_PART),
    })
  })
  const msg: MMessage = {
    ...optionsOf(m, ctx.src, [...path, 7]),
    name: str(m, "name") ?? "",
    fqn,
    fields: fields.map((f, i) => {
      const field = convertField(f, [...path, 2, i], ctx, entries)
      const oi = num(f, "oneofIndex")
      if (oi !== undefined && oneofNames.has(oi)) field.oneof = oneofNames.get(oi)
      return field
    }),
    oneofs,
    nested: [],
    enums: arr(m, "enumType").map((e, i) => convertEnum(e, `${fqn}.${str(e, "name")}`, [...path, 4, i], ctx)),
    extensions: arr(m, "extension").map((x, i) => convertField(x, [...path, 6, i], ctx, entries)),
    reservedRanges: inclusive(arr(m, "reservedRange"), true),
    reservedNames: list<string>(m, "reservedName").map(String),
    reservedLocs: {
      ranges: arr(m, "reservedRange").map((_, j) => ctx.src.at([...path, 9, j])),
      names: list<string>(m, "reservedName").map((_, j) => ctx.src.at([...path, 10, j])),
    },
    extensionRanges: arr(m, "extensionRange").map((r, i): MExtensionRange => {
      const start = num(r, "start") ?? 0
      const rangeLoc = ctx.src.at([...path, 5, i])
      return {
        ...optionsOf(r, ctx.src, [...path, 5, i, 3]),
        start,
        end: (num(r, "end") ?? start + 1) - 1,
        // the `extensions` statement holding the range (SourceCodeInfo records one location per statement)
        loc: ctx.src.containing([...path, 5], rangeLoc),
        rangeLoc,
      }
    }),
    mapEntry: get<boolean>(get<Json>(m, "options"), "mapEntry") === true || undefined,
    visibility: visibilityOf(m),
    ...ctx.src.element(path, MESSAGE_PARTS),
    file: ctx.file,
  }
  msg.nested = arr(m, "nestedType").map((n, i) =>
    convertMessage(n, `${fqn}.${str(n, "name")}`, [...path, 3, i], ctx, entries),
  )
  return msg
}

const convertService = (s: Json, fqn: string, path: number[], ctx: Ctx): MService => ({
  ...optionsOf(s, ctx.src, [...path, 3]),
  name: str(s, "name") ?? "",
  fqn,
  methods: arr(s, "method").map((m, i) => {
    const mp = [...path, 2, i]
    return {
      ...optionsOf(m, ctx.src, [...mp, 4]),
      name: str(m, "name") ?? "",
      input: { kind: "named", name: str(m, "inputType") ?? "", hint: "message" },
      output: { kind: "named", name: str(m, "outputType") ?? "", hint: "message" },
      clientStreaming: get<boolean>(m, "clientStreaming") === true,
      serverStreaming: get<boolean>(m, "serverStreaming") === true,
      ...ctx.src.element(mp, METHOD_PARTS),
    }
  }),
  ...ctx.src.element(path, NAME_PART),
  file: ctx.file,
})

/**
 * The syntax of a FileDescriptorProto (decision D-C). `edition` (a name or a number) decides when `syntax` is
 * "editions" or absent; a known edition maps to its syntax (`EDITION_PROTO3` -> "proto3"), any other is written
 * verbatim without the `EDITION_` prefix (`EDITION_UNSTABLE` -> "UNSTABLE"; a number without a name as its decimal
 * string), and `syntax: "editions"` without an edition is "editions". `unsupported` names what is not known.
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
        ? (EDITION_BY_NUMBER[Number(raw)] ?? String(Number(raw)))
        : String(raw)
  if (name === undefined || name === "EDITION_UNKNOWN")
    return syntax === "editions"
      ? { syntax: "editions", unsupported: 'syntax "editions" without an edition' }
      : { syntax: "proto2" }
  const known = KNOWN_EDITIONS[name]
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
  const file: MFile = {
    ...optionsOf(f, src, [8]),
    path,
    syntax,
    package: str(f, "package") ?? "",
    imports: [
      ...deps.map((d, i) => ({
        path: d,
        flag: publicDeps.has(i) ? ("public" as const) : weakDeps.has(i) ? ("weak" as const) : undefined,
        loc: src.at([3, i]),
      })),
      ...optionDeps.map((d, i) => ({ path: d, flag: "option" as const, loc: src.at([15, i]) })),
    ],
    messages: [],
    enums: [],
    extensions: [],
    services: [],
    locs: src.element([], FILE_PARTS).locs,
    isImport: get<boolean>(get<Json>(f, "bufExtension"), "isImport") === true,
    parsed: true,
  }
  if (!file.locs.syntax && file.locs.edition) file.locs.syntax = file.locs.edition
  delete file.locs.edition
  if (unsupported) issues.push(unsupportedEdition(unsupported, path, ptr(path), file.locs.syntax))
  if (src.empty)
    issues.push({
      code: "no-source-info",
      message: `${path} has no SourceCodeInfo; the source map is empty`,
      file: path,
    })
  // header rule (§3.3): the detached comments of the first statement, as the text producer reads them (C-12)
  const header = src.header()
  if (header.length) file.header = header.join("\n\n")
  const ctx: Ctx = { src, file, syntax }
  const pkg = file.package
  const q = (name: string) => (pkg ? `${pkg}.${name}` : name)
  const entries = new Map<string, Json>()
  arr(f, "messageType").forEach((m) => {
    const fqn = q(str(m, "name") ?? "")
    if (get<boolean>(get<Json>(m, "options"), "mapEntry")) entries.set(fqn, m)
    collectEntries(m, fqn, entries)
  })
  file.messages = arr(f, "messageType").map((m, i) => convertMessage(m, q(str(m, "name") ?? ""), [4, i], ctx, entries))
  file.enums = arr(f, "enumType").map((e, i) => convertEnum(e, q(str(e, "name") ?? ""), [5, i], ctx))
  file.services = arr(f, "service").map((s, i) => convertService(s, q(str(s, "name") ?? ""), [6, i], ctx))
  file.extensions = arr(f, "extension").map((x, i) => convertField(x, [7, i], ctx, entries))
  return file
}
