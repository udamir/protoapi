// .proto text front end: parser AST -> model. Name resolution, option typing and lowering are shared. The syntactic rules of a syntax or edition are checked here, while the AST is at hand (rules.ts); the semantic checks are in src/validate/.

import type { BuildIssue, Location } from "../../types.ts"
import type {
  MEnum,
  MExtensionRange,
  MField,
  MFile,
  MImport,
  MMessage,
  MOneof,
  MService,
  MTypeRef,
} from "../../model/index.ts"
import type {
  Enum,
  Extend,
  Extensions,
  Field,
  Group,
  Import,
  Keyword,
  MapField,
  Message,
  Oneof,
  OneofGroup,
  Service,
  Span,
  StatementBase,
  Token,
  TopLevelStatement,
} from "../../parser/index.ts"
import { newEnum, newFile, newHolder, newMessage } from "../../model/index.ts"
import { isScalar } from "../../values/scalars.ts"
import { decodeStringLiteral } from "../../values/literals.ts"
import { normalizePath, ptr } from "../../paths.ts"
import { FIELD_NUMBER_MAX, INT32_MAX, MESSAGE_SET_NUMBER_MAX } from "../../common/limits.ts"
import {
  enumPointer,
  extensionPointer,
  filePointer,
  mapEntryName,
  messagePointer,
  qualify,
} from "../../common/names.ts"
import { createLineIndex, parseProtoSource } from "../../parser/index.ts"
import { type Ctx, identText, intOf, locsOf, span, src, typeRefOf } from "./context.ts"
import { commentsOf, groupsText, tokenRange } from "./nodes.ts"
import { applyFieldOptions, isMessageSet, pushFieldOptions, pushOption } from "./options.ts"
import { convertReserved, ranges } from "./ranges.ts"
import { readHeader } from "./header.ts"
import {
  checkExtensionJsonName,
  checkExtensionRanges,
  checkGroup,
  checkImport,
  checkLabel,
  checkMapKey,
  checkOneofMembers,
  checkVisibility,
} from "./rules.ts"

/** buf's tab stop: source-map and issue columns follow buf, not protoc (8) */
export const DEFAULT_TAB_WIDTH = 4

export interface TextModelOptions {
  /** columns advance to the next multiple of this at a tab (default 4) */
  tabWidth?: number
}

// ---- fields ---------------------------------------------------------------------------------------------------------

const newField = (
  ctx: Ctx,
  n: StatementBase & { fieldNumber: Span },
  name: string,
  type: MTypeRef,
  label: string | undefined,
  parts: Record<string, Span | undefined>,
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
const convertField = (ctx: Ctx, st: Field, pointerOf: (name: string) => string, extension: boolean): MField => {
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

/** `map<K, V> name = N;`: as in a descriptor, `type` names the map entry message and `map` holds the key and value types. */
const convertMapField = (ctx: Ctx, st: MapField, fieldPointer: (name: string) => string): MField => {
  const key = identText(ctx, st.keyType)
  const name = src(ctx, st.mapName)
  const entry: MTypeRef = { kind: "named", name: mapEntryName(name), hint: "message" }
  const f = newField(ctx, st, name, entry, undefined, {
    name: st.mapName,
    number: st.fieldNumber,
    type: st.keyword,
  })
  const l = span(ctx, { start: st.keyword.start, end: st.typeBracketClose.end })
  if (l) f.locs.type = l
  f.map = { key: isScalar(key) ? key : "string", value: typeRefOf(ctx, st.valueType) }
  checkMapKey(ctx, key, isScalar(key), st.keyType, `${fieldPointer(f.name)}/propertyNames`)
  applyFieldOptions(ctx, f, st.fieldOptions)
  return f
}

/** A group statement of a message, a oneof (no label) or an extend block. */
type GroupNode = Group | (OneofGroup & { groupLabel?: undefined })

const convertGroup = (
  ctx: Ctx,
  n: GroupNode,
  label: Keyword | undefined,
  scopeFqn: string,
  nested: MMessage[],
  pointerOf: (name: string) => string,
  oneof?: string,
  extension = false,
): MField => {
  const groupName = src(ctx, n.groupName)
  const fqn = qualify(scopeFqn, groupName)
  // protoc attaches a group's comments to the generated message, not to the field
  const msg = convertMessageBody(ctx, n, n.groupName, groupName, fqn)
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
  checkGroup(ctx, n, n.keyword, label, field.name, pointer, !!oneof, extension)
  applyFieldOptions(ctx, field, n.fieldOptions)
  return field
}

const convertExtend = (ctx: Ctx, n: Extend, scopeFqn: string, out: MField[], nested: MMessage[]) => {
  const extendee = identText(ctx, n.messageType)
  const pointerOf = (name: string) => extensionPointer(qualify(scopeFqn, name))
  for (const st of n.extendBody?.statements ?? []) {
    let field: MField | undefined
    if (st.type === "field") field = convertField(ctx, st, pointerOf, true)
    else if (st.type === "group")
      field = convertGroup(ctx, st, st.groupLabel, scopeFqn, nested, pointerOf, undefined, true)
    if (!field) continue
    field.extendee = { name: extendee }
    const el = span(ctx, n.messageType)
    if (el) field.locs.extendee = el
    checkExtensionJsonName(ctx, field, pointerOf(field.name))
    out.push(field)
  }
}

// ---- messages -------------------------------------------------------------------------------------------------------

/** A oneof and its members (added to the message's fields after the fields before it). */
const convertOneof = (ctx: Ctx, st: Oneof, msg: MMessage, pointer: string, fieldPointer: (name: string) => string) => {
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
      msg.fields.push(convertGroup(ctx, os, undefined, msg.fqn, msg.nested, fieldPointer, oneofName))
      members++
    }
  }
  checkOneofMembers(ctx, st, oneofName, members, `${pointer}/oneofs/${ptr(oneofName)}`)
}

/** An `extensions` statement: one extension range per range written, each with the statement's options. */
const convertExtensions = (ctx: Ctx, st: Extensions, msg: MMessage, pointer: string) => {
  checkExtensionRanges(ctx, st, `${pointer}/extensions`)
  for (const range of ranges(ctx, st.ranges, FIELD_NUMBER_MAX)) {
    const r: MExtensionRange = { ...newHolder(), start: range.start, end: range.end, loc: span(ctx, st) }
    if (range.loc) r.rangeLoc = range.loc
    if (range.toMax) r.toMax = true
    pushFieldOptions(ctx, r, st.fieldOptions)
    msg.extensionRanges.push(r)
  }
  if (!msg.locs.extensions) {
    const l = span(ctx, st)
    if (l) msg.locs.extensions = l
  }
}

/** `export` / `local` (edition 2024) before a message or enum. */
const visibilityOf = (
  ctx: Ctx,
  n: Span & { visibility?: Keyword },
  pointer: string,
): "export" | "local" | undefined => {
  const v = n.visibility?.text
  if (v !== "export" && v !== "local") return undefined
  checkVisibility(ctx, n.visibility as Keyword, pointer)
  return v
}

/** A message, or the message of a group (`nameNode` is the message or group name). */
const convertMessageBody = (ctx: Ctx, n: Message | GroupNode, nameNode: Token, name: string, fqn: string): MMessage => {
  const pointer = messagePointer(fqn)
  const fieldPointer = (f: string) => `${pointer}/properties/${ptr(f)}`
  const msg = newMessage(newHolder(), name, fqn, ctx.file, {
    visibility: visibilityOf(ctx, n, pointer),
    comments: commentsOf(n),
    locs: locsOf(ctx, n, { name: nameNode }),
  })
  const reservedToMax: number[] = []
  for (const st of n.messageBody?.statements ?? []) {
    switch (st.type) {
      case "field": {
        msg.fields.push(convertField(ctx, st, fieldPointer, false))
        break
      }
      case "map-field":
        msg.fields.push(convertMapField(ctx, st, fieldPointer))
        break
      case "group":
        msg.fields.push(convertGroup(ctx, st, st.groupLabel, fqn, msg.nested, fieldPointer))
        break
      case "oneof":
        convertOneof(ctx, st, msg, pointer, fieldPointer)
        break
      case "message":
        msg.nested.push(convertMessage(ctx, st, fqn))
        break
      case "enum":
        msg.enums.push(convertEnum(ctx, st, fqn))
        break
      case "extend":
        convertExtend(ctx, st, fqn, msg.extensions, msg.nested)
        break
      case "extensions":
        convertExtensions(ctx, st, msg, pointer)
        break
      case "reserved":
        convertReserved(ctx, msg, st, FIELD_NUMBER_MAX, pointer, reservedToMax)
        break
      case "option":
        pushOption(ctx, msg, st.optionName, st.constant, st)
        break
    }
  }
  // `reserved N to max` in a message set ends at 2147483646, like its extension ranges (as in protoc)
  if (reservedToMax.length && isMessageSet(ctx, msg))
    for (const i of reservedToMax) msg.reservedRanges[i][1] = MESSAGE_SET_NUMBER_MAX
  return msg
}

const convertMessage = (ctx: Ctx, n: Message, scopeFqn: string): MMessage => {
  const name = src(ctx, n.messageName)
  return convertMessageBody(ctx, n, n.messageName, name, qualify(scopeFqn, name))
}

// ---- enums ----------------------------------------------------------------------------------------------------------

const convertEnum = (ctx: Ctx, n: Enum, scopeFqn: string): MEnum => {
  const name = src(ctx, n.enumName)
  const fqn = qualify(scopeFqn, name)
  const e = newEnum(newHolder(), name, fqn, ctx.file, {
    visibility: visibilityOf(ctx, n, enumPointer(fqn)),
    comments: commentsOf(n),
    locs: locsOf(ctx, n, { name: n.enumName }),
  })
  for (const st of n.enumBody?.statements ?? []) {
    if (st.type === "enum-field") {
      const v = {
        ...newHolder(),
        name: src(ctx, st.fieldName),
        number: intOf(ctx, st.fieldNumber),
        comments: commentsOf(st),
        locs: locsOf(ctx, st, { name: st.fieldName, number: st.fieldNumber }),
      }
      pushFieldOptions(ctx, v, st.fieldOptions)
      e.values.push(v)
    } else if (st.type === "option") pushOption(ctx, e, st.optionName, st.constant, st)
    else if (st.type === "reserved") convertReserved(ctx, e, st, INT32_MAX, enumPointer(fqn), [])
  }
  return e
}

// ---- services -------------------------------------------------------------------------------------------------------

const convertService = (ctx: Ctx, n: Service): MService => {
  const name = src(ctx, n.serviceName)
  const fqn = qualify(ctx.pkg, name)
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

// ---- file -----------------------------------------------------------------------------------------------------------

/** An import statement, its flag checked against the syntax and the `import option` order. */
const convertImport = (ctx: Ctx, st: Import, afterOptionImport: boolean): MImport => {
  const flagText = st.weakOrPublic?.text
  const flag = flagText === "public" || flagText === "weak" || flagText === "option" ? flagText : undefined
  checkImport(ctx, st, flag, afterOptionImport, `${filePointer(ctx.path)}/imports/${ctx.file.imports.length}`)
  return {
    path: normalizePath(decodeStringLiteral(src(ctx, st.strLit))),
    flag,
    loc: span(ctx, st),
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
  const tabWidth = options.tabWidth ?? DEFAULT_TAB_WIDTH
  const lines = createLineIndex(text, { tabWidth })
  const loc = (start: number, end: number): Location => ({
    file: path,
    start: lines.toPosition(start),
    end: lines.toPosition(end),
  })
  const file = newFile(newHolder(), path, "proto2", "", [], {}, { bundled })
  const ctx: Ctx = { path, text, loc, syntax: "proto2", pkg: "", file, issues, check: !bundled }
  const result = parseProtoSource(text, path, { tabWidth })
  if (result.error) {
    file.parsed = false
    issues.push(...result.issues)
    // keep the syntax and package statements parsed before the error. A file whose first complete statement is not a syntax / edition statement is proto2; with no complete statement the syntax is not known.
    const partial: TopLevelStatement[] = result.ast.statements.filter((st) => st.type !== "empty")
    if (partial.length) readHeader({ ...ctx, check: false }, partial)
    else file.syntaxUnknown = true
    return file
  }
  const statements: TopLevelStatement[] = result.ast.statements
  // syntax and package first: they scope everything else
  readHeader(ctx, statements)
  ctx.syntax = file.syntax
  ctx.pkg = file.package
  if (statements.length) {
    const first = tokenRange(statements[0])
    const last = tokenRange(statements[statements.length - 1])
    if (first && last) file.locs[""] = loc(first[0], last[1])
    const detached = statements[0].leadingDetachedComments
    if (detached?.length) file.header = groupsText(detached)?.replace(/\n?$/, "")
  }
  let optionImportSeen = false
  for (const st of statements) {
    switch (st.type) {
      case "import": {
        const imp = convertImport(ctx, st, optionImportSeen)
        if (imp.flag === "option") optionImportSeen = true
        file.imports.push(imp)
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
