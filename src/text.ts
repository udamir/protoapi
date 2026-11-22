// .proto text front end (design §5): parser AST -> model. Name resolution, option typing and lowering are shared.
// The syntactic rules of a syntax or edition (labels, groups, statement order, keywords per edition) are checked
// here, while the AST is at hand (validation decision D-E); the semantic checks are in validate.ts.

import type { BuildIssue, BuildIssueCode, Location, ProtoSyntax } from "./types.ts"
import type {
  Locs,
  MComments,
  MEnum,
  MExtensionRange,
  MField,
  MFile,
  MMessage,
  MOneof,
  MOptionHolder,
  MService,
  MTypeRef,
} from "./model.ts"
import { newHolder } from "./model.ts"
import { protocGroupText } from "./comments.ts"
import { isScalar, parseIntText, decodeStringLiteral } from "./values.ts"
import { normalizePath, ptr } from "./paths.ts"
import { editionNumber, EDITION_NUMBERS, isEditions, isKnownSyntax, unsupportedEdition } from "./features.ts"
import { TRIVIA, addPending, optionNameSegments, tokensText } from "./options.ts"
import { createLineIndex } from "./parser/index.ts"
import { parse } from "./parser/proto.ts"

const MESSAGE_MAX = 536870911
const ENUM_MAX = 2147483647
/** `max` in a message with `message_set_wire_format = true` (protoc, IN-5b / C-7) */
const MESSAGE_SET_MAX = 2147483646
/** buf's tab stop (validation decision D-A) */
export const DEFAULT_TAB_WIDTH = 4

/** Structural view of parser nodes (pbkit AST, see src/parser/ast). */
type Node = any

interface Ctx {
  path: string
  text: string
  loc: (start: number, end: number) => Location
  syntax: ProtoSyntax
  pkg: string
  file: MFile
  issues: BuildIssue[]
  /** files are checked only when they are not bundled (bundled definitions are valid) */
  check: boolean
}

export interface TextModelOptions {
  /** columns advance to the next multiple of this at a tab (default 4) */
  tabWidth?: number
}

const COMMENT_KEYS = new Set(["leadingComments", "trailingComments", "leadingDetachedComments"])

/** Token range of a node without its attached comments (protoc spans start at the first token). */
const tokenRange = (n: Node): [number, number] | undefined => {
  if (!n || typeof n.start !== "number") return undefined
  if (!("leadingComments" in n) && !("trailingComments" in n)) return [n.start, n.end]
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const k in n) {
    const v = n[k]
    // buf starts a message / enum span after the edition 2024 `export` / `local` keyword
    if (!v || typeof v !== "object" || COMMENT_KEYS.has(k) || k === "visibility") continue
    const items = Array.isArray(v) ? v : [v]
    for (const it of items as Node[]) {
      if (!it || typeof it.start !== "number" || it.type === "comment-group") continue
      const r = tokenRange(it)
      if (!r) continue
      if (r[0] < start) start = r[0]
      if (r[1] > end) end = r[1]
    }
  }
  return Number.isFinite(start) ? [start, end] : [n.start, n.end]
}

const span = (ctx: Ctx, n: Node | undefined): Location | undefined => {
  const r = tokenRange(n)
  return r ? ctx.loc(r[0], r[1]) : undefined
}

const src = (ctx: Ctx, n: Node): string => ctx.text.slice(n.start, n.end)

const groupsText = (groups: Node[] | undefined): string | undefined => {
  if (!groups?.length) return undefined
  return groups.map((g: Node) => protocGroupText((g.comments ?? []).map((c: Node) => c.text as string))).join("\n")
}

const commentsOf = (n: Node): MComments => {
  const leading = n.leadingComments?.length ? groupsText([n.leadingComments[n.leadingComments.length - 1]]) : undefined
  const trailing = groupsText(n.trailingComments)
  return { leading, trailing }
}

/** A dotted name as written, without the whitespace and comments between its tokens (C-15). */
const identText = (ctx: Ctx, n: Node): string => tokensText(n, (x) => src(ctx, x as Node))

const intOf = (ctx: Ctx, n: Node | undefined): number => {
  if (!n) return 0
  const v = parseIntText(src(ctx, n).replace(TRIVIA, ""))
  return v === undefined ? 0 : Number(v)
}

const typeRefOf = (ctx: Ctx, n: Node): MTypeRef => {
  const name = identText(ctx, n)
  return isScalar(name) ? { kind: "scalar", scalar: name } : { kind: "named", name }
}

// ---- issues ---------------------------------------------------------------------------------------------------------

const filePointer = (ctx: Ctx) => `#/files/${ptr(ctx.path)}`
const messagePointer = (fqn: string) => `#/components/messages/${ptr(fqn)}`
const enumPointer = (fqn: string) => `#/components/enums/${ptr(fqn)}`
const extensionPointer = (fqn: string) => `#/components/extensions/${ptr(fqn)}`

const report = (
  ctx: Ctx,
  code: BuildIssueCode,
  message: string,
  at: Node | Location | undefined,
  pointer: string | undefined,
) => {
  if (!ctx.check) return
  const location = at && "file" in at ? (at as Location) : span(ctx, at as Node)
  ctx.issues.push({ code, message, file: ctx.path, location, pointer })
}

const syntaxName = (syntax: ProtoSyntax) => (isEditions(syntax) ? `edition ${syntax}` : syntax)

// ---- options ----------------------------------------------------------------------------------------------------------

const pushOption = (ctx: Ctx, holder: MOptionHolder, optionName: Node, constant: Node, at: Node) => {
  // buf: an option statement `option (name) = { … };` (one name segment, aggregate value; at file level too) is
  // located from the option name to the closing brace; other option statements (sub-paths, scalar values) cover the
  // whole statement. For a repeated option field the whole statement is used too (C-10); the interpreter picks
  // `stmtLoc` once the field is known.
  const whole = span(ctx, at)
  const nameToBrace =
    at.type === "option" &&
    constant?.type === "aggregate" &&
    optionNameSegments(optionName, (x) => src(ctx, x)).length === 1
  const loc = nameToBrace ? ctx.loc(optionName.start, constant.end) : whole
  holder.raw.push({
    kind: "text",
    name: optionName,
    value: constant,
    text: src(ctx, constant).trim(),
    loc,
    ...(nameToBrace ? { stmtLoc: whole } : {}),
  })
}

const fieldOptionList = (n: Node | undefined): Node[] =>
  (n?.fieldOptionOrCommas ?? []).filter((x: Node) => x.type === "field-option")

/** Field options, with the pseudo-options json_name and default moved to the field. */
const applyFieldOptions = (ctx: Ctx, field: MField, fieldOptions: Node | undefined) => {
  for (const o of fieldOptionList(fieldOptions)) {
    const segs = optionNameSegments(o.optionName, (x) => src(ctx, x))
    if (segs.length === 1 && !segs[0].ext && segs[0].name === "json_name") {
      if (field.jsonName !== undefined)
        addPending(field, { code: "invalid-option", message: "json_name is set more than once", loc: span(ctx, o) })
      field.jsonName = decodeStringLiteral(src(ctx, o.constant))
      const l = span(ctx, o)
      if (l) field.locs.jsonName = l
      continue
    }
    if (segs.length === 1 && !segs[0].ext && segs[0].name === "default") {
      if (field.default !== undefined)
        addPending(field, { code: "invalid-option", message: "default is set more than once", loc: span(ctx, o) })
      field.default = { kind: "text", value: o.constant }
      const l = span(ctx, o)
      if (l) field.locs.default = l
      continue
    }
    pushOption(ctx, field, o.optionName, o.constant, o)
  }
}

const locsOf = (ctx: Ctx, n: Node, parts: Record<string, Node | undefined>): Locs => {
  const out: Locs = {}
  const self = span(ctx, n)
  if (self) out[""] = self
  for (const [k, p] of Object.entries(parts)) {
    const l = span(ctx, p)
    if (l) out[k] = l
  }
  return out
}

const newField = (
  ctx: Ctx,
  n: Node,
  name: string,
  type: MTypeRef,
  label: string | undefined,
  parts: Record<string, Node | undefined>,
): MField => ({
  ...newHolder(),
  name,
  number: intOf(ctx, n.fieldNumber),
  repeated: label === "repeated",
  required: label === "required",
  optional: label === "optional",
  type,
  comments: commentsOf(n),
  locs: locsOf(ctx, n, parts),
})

/** A field statement (of a message or an extend block): the field, its label checked, its options. */
const convertField = (ctx: Ctx, st: Node, pointerOf: (name: string) => string, extension: boolean): MField => {
  const f = newField(ctx, st, src(ctx, st.fieldName), typeRefOf(ctx, st.fieldType), st.fieldLabel?.text, {
    name: st.fieldName,
    number: st.fieldNumber,
    type: st.fieldType,
    label: st.fieldLabel,
  })
  checkLabel(ctx, st, st.fieldLabel, f.name, pointerOf(f.name), extension)
  applyFieldOptions(ctx, f, st.fieldOptions)
  return f
}

/**
 * The label rules of the file's syntax (D-E): proto2 fields outside a oneof need a label, proto3 has no `required`,
 * editions have neither `optional` nor `required` (features.field_presence replaces them), extensions are never
 * `required`.
 */
const checkLabel = (ctx: Ctx, n: Node, label: Node | undefined, what: string, pointer: string, extension: boolean) => {
  const text: string | undefined = label?.text
  if (extension && text === "required") {
    report(ctx, "invalid-definition", `extension ${what} cannot be required`, label, pointer)
    return
  }
  if (ctx.syntax === "proto2") {
    if (!label)
      report(
        ctx,
        "invalid-definition",
        `field ${what} needs a label (optional, required or repeated) in proto2`,
        n,
        pointer,
      )
  } else if (ctx.syntax === "proto3") {
    if (text === "required")
      report(ctx, "invalid-definition", `required fields are not allowed in proto3 (${what})`, label, pointer)
  } else if (text === "optional" || text === "required") {
    report(
      ctx,
      "invalid-definition",
      `the label "${text}" is not allowed in editions (${what}); use features.field_presence instead`,
      label,
      pointer,
    )
  }
}

/** Ranges of a `reserved` / `extensions` statement, each with its own location. */
interface ParsedRange {
  start: number
  end: number
  toMax: boolean
  loc?: Location
}

const ranges = (ctx: Ctx, rangesNode: Node, max: number): ParsedRange[] => {
  const out: ParsedRange[] = []
  for (const r of rangesNode?.rangeOrCommas ?? []) {
    if (r.type !== "range") continue
    const start = intOf(ctx, r.rangeStart)
    let end = start
    let toMax = false
    if (r.rangeEnd) {
      toMax = r.rangeEnd.type === "max" || src(ctx, r.rangeEnd).trim() === "max"
      end = toMax ? max : intOf(ctx, r.rangeEnd)
    }
    out.push({ start, end, toMax, loc: span(ctx, r) })
  }
  return out
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reserved names of a `reserved` statement. Editions write them as identifiers, proto2 / proto3 as string literals,
 * and a quoted name must be an identifier (D-E; buf: "cannot use string literals in reserved range in editions mode",
 * "reserved message field name is not a valid identifier").
 */
/** A `reserved` statement of a message or enum; `toMax` collects the indexes of `N to max` ranges. */
const convertReserved = (
  ctx: Ctx,
  holder: MMessage | MEnum,
  st: Node,
  max: number,
  pointer: string,
  toMax: number[],
) => {
  const isRanges = st.reserved?.type === "ranges"
  if (isRanges)
    for (const range of ranges(ctx, st.reserved, max)) {
      if (range.toMax) toMax.push(holder.reservedRanges.length)
      holder.reservedRanges.push([range.start, range.end])
      holder.reservedLocs?.ranges.push(range.loc)
    }
  else
    for (const r of reservedNames(ctx, st.reserved, `${pointer}/reserved`)) {
      holder.reservedNames.push(r.name)
      holder.reservedLocs?.names.push(r.loc)
    }
  const key = isRanges ? "reserved" : "reservedNames"
  if (!holder.locs[key]) {
    const l = span(ctx, st)
    if (l) holder.locs[key] = l
  }
}

const reservedNames = (ctx: Ctx, namesNode: Node, pointer: string): { name: string; loc?: Location }[] => {
  const out: { name: string; loc?: Location }[] = []
  const items = namesNode?.strLitOrCommas ?? namesNode?.strLitOrIdentOrCommas ?? namesNode?.names ?? []
  const editions = isEditions(ctx.syntax)
  for (const x of items) {
    if (x.type === "comma") continue
    const quoted = x.type === "str-lit"
    const name = quoted ? decodeStringLiteral(src(ctx, x)) : src(ctx, x).trim()
    const loc = span(ctx, x)
    if (quoted === editions)
      report(
        ctx,
        "invalid-definition",
        editions
          ? `reserved names are identifiers in editions, not string literals ("${name}")`
          : `reserved names are string literals in ${ctx.syntax} (${name})`,
        loc,
        pointer,
      )
    else if (!IDENT.test(name))
      report(ctx, "invalid-definition", `reserved name "${name}" is not a valid identifier`, loc, pointer)
    out.push({ name, loc })
  }
  return out
}

const visibilityOf = (ctx: Ctx, n: Node, pointer: string): "export" | "local" | undefined => {
  const v = n.visibility?.text
  if (v !== "export" && v !== "local") return undefined
  if (editionNumber(ctx.syntax) < EDITION_NUMBERS.EDITION_2024)
    report(ctx, "invalid-definition", `\`${v}\` is not supported in ${syntaxName(ctx.syntax)}`, n.visibility, pointer)
  return v
}

/** `option message_set_wire_format = true;` among the raw options of a message (text form, before typing). */
const isMessageSet = (ctx: Ctx, m: MMessage): boolean =>
  m.raw.some(
    (r) =>
      r.kind === "text" &&
      r.text === "true" &&
      optionNameSegments(r.name, (x) => src(ctx, x))
        .map((s) => (s.ext ? `(${s.name})` : s.name))
        .join(".") === "message_set_wire_format",
  )

// ---- messages -------------------------------------------------------------------------------------------------------

const convertGroup = (
  ctx: Ctx,
  n: Node,
  label: Node | undefined,
  scopeFqn: string,
  nested: MMessage[],
  pointerOf: (name: string) => string,
  oneof?: string,
  extension = false,
): MField => {
  const groupName = src(ctx, n.groupName)
  const fqn = scopeFqn ? `${scopeFqn}.${groupName}` : groupName
  // protoc attaches a group's comments to the generated message, not to the field
  const msg = convertMessageBody(ctx, n, groupName, fqn, n.messageBody)
  nested.push(msg)
  const field = newField(ctx, n, groupName.toLowerCase(), { kind: "named", name: `.${fqn}` }, label?.text, {
    name: n.groupName,
    number: n.fieldNumber,
    label: n.groupLabel,
    type: n.keyword,
  })
  field.group = true
  field.comments = {}
  if (oneof) field.oneof = oneof
  const pointer = pointerOf(field.name)
  if (ctx.syntax !== "proto2")
    report(ctx, "invalid-definition", `group syntax is not supported in ${syntaxName(ctx.syntax)}`, n.keyword, pointer)
  else if (!oneof) checkLabel(ctx, n, label, field.name, pointer, extension)
  applyFieldOptions(ctx, field, n.fieldOptions)
  return field
}

const convertExtend = (ctx: Ctx, n: Node, scopeFqn: string, out: MField[], nested: MMessage[]) => {
  const extendee = identText(ctx, n.messageType)
  const pointerOf = (name: string) => extensionPointer(scopeFqn ? `${scopeFqn}.${name}` : name)
  for (const st of n.extendBody?.statements ?? []) {
    let field: MField | undefined
    if (st.type === "field") {
      field = convertField(ctx, st, pointerOf, true)
    } else if (st.type === "group") {
      field = convertGroup(ctx, st, st.groupLabel, scopeFqn, nested, pointerOf, undefined, true)
    } else if (st.type === "malformed-field") syntaxIssue(ctx, st, "malformed extension field")
    if (!field) continue
    field.extendee = { name: extendee }
    const el = span(ctx, n.messageType)
    if (el) field.locs.extendee = el
    if (field.jsonName !== undefined)
      report(
        ctx,
        "invalid-option",
        `json_name is not allowed on extension ${field.name}`,
        field.locs.jsonName,
        pointerOf(field.name),
      )
    out.push(field)
  }
}

const syntaxIssue = (ctx: Ctx, n: Node, message: string) => {
  ctx.issues.push({ code: "syntax", message, file: ctx.path, location: span(ctx, n) })
}

const MAP_KEY_INVALID = new Set(["float", "double", "bytes"])

const convertMessageBody = (ctx: Ctx, n: Node, name: string, fqn: string, body: Node): MMessage => {
  const pointer = messagePointer(fqn)
  const fieldPointer = (f: string) => `${pointer}/properties/${ptr(f)}`
  const msg: MMessage = {
    ...newHolder(),
    name,
    fqn,
    fields: [],
    oneofs: [],
    nested: [],
    enums: [],
    extensions: [],
    reservedRanges: [],
    reservedNames: [],
    reservedLocs: { ranges: [], names: [] },
    extensionRanges: [],
    visibility: visibilityOf(ctx, n, pointer),
    comments: commentsOf(n),
    locs: locsOf(ctx, n, { name: n.messageName ?? n.groupName }),
    file: ctx.file,
  }
  const reservedToMax: number[] = []
  for (const st of body?.statements ?? []) {
    switch (st.type) {
      case "field": {
        msg.fields.push(convertField(ctx, st, fieldPointer, false))
        break
      }
      case "map-field": {
        const key = identText(ctx, st.keyType)
        const f = newField(ctx, st, src(ctx, st.mapName), { kind: "named", name: "" }, undefined, {
          name: st.mapName,
          number: st.fieldNumber,
          type: st.keyword,
        })
        const l = span(ctx, { start: st.keyword.start, end: st.typeBracketClose.end })
        if (l) f.locs.type = l
        f.map = { key: isScalar(key) ? key : "string", value: typeRefOf(ctx, st.valueType) }
        f.type = f.map.value
        // the map key must be an integral, bool or string scalar (D-E: a message key used to become `string`)
        if (!isScalar(key) || MAP_KEY_INVALID.has(key))
          report(
            ctx,
            "unresolved-type",
            `map key type ${key} is not allowed: a map key must be an integer, bool or string type`,
            st.keyType,
            `${fieldPointer(f.name)}/propertyNames`,
          )
        applyFieldOptions(ctx, f, st.fieldOptions)
        msg.fields.push(f)
        break
      }
      case "group":
        msg.fields.push(convertGroup(ctx, st, st.groupLabel, fqn, msg.nested, fieldPointer))
        break
      case "oneof": {
        const oneofName = src(ctx, st.oneofName)
        const oneof: MOneof = {
          ...newHolder(),
          name: oneofName,
          comments: commentsOf(st),
          locs: locsOf(ctx, st, { name: st.oneofName }),
        }
        msg.oneofs.push(oneof)
        let members = 0
        for (const os of st.oneofBody?.statements ?? []) {
          if (os.type === "option") pushOption(ctx, oneof, os.optionName, os.constant, os)
          else if (os.type === "oneof-field") {
            const f = newField(ctx, os, src(ctx, os.fieldName), typeRefOf(ctx, os.fieldType), undefined, {
              name: os.fieldName,
              number: os.fieldNumber,
              type: os.fieldType,
            })
            f.oneof = oneofName
            applyFieldOptions(ctx, f, os.fieldOptions)
            msg.fields.push(f)
            members++
          } else if (os.type === "oneof-group") {
            msg.fields.push(convertGroup(ctx, os, undefined, fqn, msg.nested, fieldPointer, oneofName))
            members++
          }
        }
        if (!members)
          report(
            ctx,
            "invalid-definition",
            `oneof ${oneofName} must have at least one member`,
            st,
            `${pointer}/oneofs/${ptr(oneofName)}`,
          )
        break
      }
      case "message":
        msg.nested.push(convertMessage(ctx, st, fqn))
        break
      case "enum":
        msg.enums.push(convertEnum(ctx, st, fqn))
        break
      case "extend":
        convertExtend(ctx, st, fqn, msg.extensions, msg.nested)
        break
      case "extensions": {
        if (ctx.syntax === "proto3")
          report(ctx, "invalid-definition", "extension ranges are not allowed in proto3", st, `${pointer}/extensions`)
        for (const range of ranges(ctx, st.ranges, MESSAGE_MAX)) {
          const r: MExtensionRange = { ...newHolder(), start: range.start, end: range.end, loc: span(ctx, st) }
          if (range.loc) r.rangeLoc = range.loc
          if (range.toMax) r.toMax = true
          for (const o of fieldOptionList(st.fieldOptions)) pushOption(ctx, r, o.optionName, o.constant, o)
          msg.extensionRanges.push(r)
        }
        if (!msg.locs.extensions) {
          const l = span(ctx, st)
          if (l) msg.locs.extensions = l
        }
        break
      }
      case "reserved":
        convertReserved(ctx, msg, st, MESSAGE_MAX, pointer, reservedToMax)
        break
      case "option":
        pushOption(ctx, msg, st.optionName, st.constant, st)
        break
      case "malformed-field":
        syntaxIssue(ctx, st, "malformed field")
        break
    }
  }
  // C-7: `reserved N to max` in a message set ends at 2147483646, like its extension ranges (IN-5b)
  if (reservedToMax.length && isMessageSet(ctx, msg))
    for (const i of reservedToMax) msg.reservedRanges[i][1] = MESSAGE_SET_MAX
  return msg
}

const convertMessage = (ctx: Ctx, n: Node, scopeFqn: string): MMessage => {
  const name = src(ctx, n.messageName)
  return convertMessageBody(ctx, n, name, scopeFqn ? `${scopeFqn}.${name}` : name, n.messageBody)
}

// ---- enums -------------------------------------------------------------------------------------------------------------

const convertEnum = (ctx: Ctx, n: Node, scopeFqn: string): MEnum => {
  const name = src(ctx, n.enumName)
  const fqn = scopeFqn ? `${scopeFqn}.${name}` : name
  const e: MEnum = {
    ...newHolder(),
    name,
    fqn,
    values: [],
    reservedRanges: [],
    reservedNames: [],
    reservedLocs: { ranges: [], names: [] },
    visibility: visibilityOf(ctx, n, enumPointer(fqn)),
    comments: commentsOf(n),
    locs: locsOf(ctx, n, { name: n.enumName }),
    file: ctx.file,
  }
  for (const st of n.enumBody?.statements ?? []) {
    if (st.type === "enum-field") {
      const v = {
        ...newHolder(),
        name: src(ctx, st.fieldName),
        number: intOf(ctx, st.fieldNumber),
        comments: commentsOf(st),
        locs: locsOf(ctx, st, { name: st.fieldName, number: st.fieldNumber }),
      }
      for (const o of fieldOptionList(st.fieldOptions)) pushOption(ctx, v, o.optionName, o.constant, o)
      e.values.push(v)
    } else if (st.type === "option") pushOption(ctx, e, st.optionName, st.constant, st)
    else if (st.type === "reserved") convertReserved(ctx, e, st, ENUM_MAX, enumPointer(fqn), [])
  }
  return e
}

// ---- services -----------------------------------------------------------------------------------------------------------

const convertService = (ctx: Ctx, n: Node): MService => {
  const name = src(ctx, n.serviceName)
  const fqn = ctx.pkg ? `${ctx.pkg}.${name}` : name
  const s: MService = {
    ...newHolder(),
    name,
    fqn,
    methods: [],
    comments: commentsOf(n),
    locs: locsOf(ctx, n, { name: n.serviceName }),
    file: ctx.file,
  }
  for (const st of n.serviceBody?.statements ?? []) {
    if (st.type === "option") pushOption(ctx, s, st.optionName, st.constant, st)
    else if (st.type === "rpc") {
      const m = {
        ...newHolder(),
        name: src(ctx, st.rpcName),
        input: { kind: "named", name: identText(ctx, st.reqType.messageType) } as MTypeRef,
        output: { kind: "named", name: identText(ctx, st.resType.messageType) } as MTypeRef,
        clientStreaming: !!st.reqType.stream,
        serverStreaming: !!st.resType.stream,
        comments: commentsOf(st),
        locs: locsOf(ctx, st, {
          name: st.rpcName,
          request: st.reqType.messageType,
          response: st.resType.messageType,
          "request/stream": st.reqType.stream,
          "response/stream": st.resType.stream,
        }),
      }
      if (st.semiOrRpcBody?.type === "rpc-body") {
        for (const os of st.semiOrRpcBody.statements ?? [])
          if (os.type === "option") pushOption(ctx, m, os.optionName, os.constant, os)
      }
      s.methods.push(m)
    }
  }
  return s
}

// ---- file ---------------------------------------------------------------------------------------------------------------

const syntaxValue = (ctx: Ctx, st: Node): string =>
  src(ctx, st.type === "syntax" ? st.syntax : st.edition).replace(/["']/g, "")

/**
 * The syntax / edition and package statements (they scope everything else). The first of each wins; a second one,
 * or a syntax statement that is not the first statement, is an `invalid-definition` (buf: "unexpected `syntax`
 * declaration"). An unknown `syntax` value (`"proto4"`) is an `invalid-definition` and the file is read as proto2, as
 * the descriptor producer reads an unknown descriptor `syntax`; an unknown edition is kept verbatim (D-C).
 */
const readHeader = (ctx: Ctx, statements: Node[], issues: BuildIssue[]) => {
  const { file, path } = ctx
  const fp = filePointer(ctx)
  let syntaxSeen = false
  let packageSeen = false
  let first = true
  for (const st of statements) {
    if (st.type === "empty") continue
    if (st.type === "syntax" || st.type === "edition") {
      if (syntaxSeen) {
        report(
          ctx,
          "invalid-definition",
          `unexpected \`${st.type}\` declaration: the file already declares its syntax`,
          st,
          `${fp}/syntax`,
        )
        continue
      }
      if (!first)
        report(
          ctx,
          "invalid-definition",
          `the \`${st.type}\` declaration must be the first statement of the file`,
          st,
          `${fp}/syntax`,
        )
      syntaxSeen = true
      const v = syntaxValue(ctx, st)
      if (st.type === "syntax") {
        file.syntax = v === "proto3" ? "proto3" : "proto2"
        if (v !== "proto2" && v !== "proto3")
          report(
            ctx,
            "invalid-definition",
            `unrecognized syntax "${v}" (proto2 or proto3 expected); the file is read as proto2`,
            st.syntax,
            `${fp}/syntax`,
          )
      } else {
        // D-C: a known edition, else the edition string verbatim with an `unsupported` issue
        file.syntax = v
        if (!isKnownSyntax(v) || !isEditions(v))
          issues.push(unsupportedEdition(`edition "${v}"`, path, ptr(path), ctx.loc(st.start, st.end)))
      }
      file.locs.syntax = span(ctx, st) as Location
    } else if (st.type === "package") {
      if (packageSeen)
        report(
          ctx,
          "invalid-definition",
          "unexpected `package` declaration: the file already declares a package",
          st,
          `${fp}/package`,
        )
      else {
        packageSeen = true
        file.package = identText(ctx, st.fullIdent)
        file.locs.package = span(ctx, st) as Location
      }
    }
    first = false
  }
}

/** Parse and convert one `.proto` file. */
export const textToModel = (
  rawPath: string,
  text: string,
  issues: BuildIssue[],
  bundled = false,
  options: TextModelOptions = {},
): MFile => {
  const path = normalizePath(rawPath)
  const lines = createLineIndex(text, { tabWidth: options.tabWidth ?? DEFAULT_TAB_WIDTH })
  const loc = (start: number, end: number): Location => ({
    file: path,
    start: lines.toPosition(start),
    end: lines.toPosition(end),
  })
  const file: MFile = {
    ...newHolder(),
    path,
    syntax: "proto2",
    package: "",
    imports: [],
    messages: [],
    enums: [],
    extensions: [],
    services: [],
    locs: {},
    bundled,
    parsed: true,
  }
  const ctx: Ctx = { path, text, loc, syntax: "proto2", pkg: "", file, issues, check: !bundled }
  const result = parse(text)
  if (result.error) {
    file.parsed = false
    issues.push({
      code: "syntax",
      message: result.error.message,
      file: path,
      location: loc(result.error.offset, result.error.offset),
    })
    // text#14: keep the syntax and package statements parsed before the error. A file whose first complete statement
    // is not a syntax / edition statement is proto2; with no complete statement the syntax is not known.
    const partial: Node[] = (result.partial ?? []).filter((st: Node) => st.type !== "empty")
    if (partial.length) readHeader({ ...ctx, check: false }, partial, issues)
    else file.syntaxUnknown = true
    return file
  }
  const statements: Node[] = result.ast.statements
  // syntax and package first: they scope everything else
  readHeader(ctx, statements, issues)
  ctx.syntax = file.syntax
  ctx.pkg = file.package
  if (statements.length) {
    const first = tokenRange(statements[0])
    const last = tokenRange(statements[statements.length - 1])
    if (first && last) file.locs[""] = loc(first[0], last[1])
    const detached = statements[0].leadingDetachedComments
    if (detached?.length) file.header = groupsText(detached)?.replace(/\n?$/, "")
  }
  const fp = filePointer(ctx)
  let optionImportSeen = false
  for (const st of statements) {
    switch (st.type) {
      case "import": {
        const flagText = st.weakOrPublic?.text ?? st.modifier?.text
        const flag = flagText === "public" || flagText === "weak" || flagText === "option" ? flagText : undefined
        const pointer = `${fp}/imports/${file.imports.length}`
        const edition = editionNumber(ctx.syntax)
        if (flag === "option" && edition < EDITION_NUMBERS.EDITION_2024)
          report(
            ctx,
            "invalid-definition",
            `\`import option\` is not supported in ${syntaxName(ctx.syntax)}`,
            st,
            pointer,
          )
        else if (flag === "weak" && edition >= EDITION_NUMBERS.EDITION_2024)
          report(
            ctx,
            "invalid-definition",
            `\`import weak\` is not supported in ${syntaxName(ctx.syntax)}`,
            st,
            pointer,
          )
        if (flag === "option") optionImportSeen = true
        else if (optionImportSeen)
          report(ctx, "invalid-definition", "import after `import option`: option imports must come last", st, pointer)
        file.imports.push({
          path: normalizePath(decodeStringLiteral(src(ctx, st.strLit))),
          flag,
          loc: span(ctx, st),
        })
        break
      }
      case "option":
        pushOption(ctx, file, st.optionName, st.constant, st)
        break
      case "message":
        file.messages.push(convertMessage(ctx, st, file.package))
        break
      case "enum":
        file.enums.push(convertEnum(ctx, st, file.package))
        break
      case "extend":
        convertExtend(ctx, st, file.package, file.extensions, file.messages)
        break
      case "service":
        file.services.push(convertService(ctx, st))
        break
    }
  }
  return file
}
