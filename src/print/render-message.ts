// Message declarations and the scopes inside them: nested messages, `extend` blocks and fields in document order, oneofs, proto2 groups (printed by the field that declares them), wrapper messages for missing parents.

import type { ProtoApiExtension, ProtoApiField, ProtoApiMessage } from "../types.ts"
import { OPENAPIV2_SCHEMA } from "../conventions/keys.ts"
import { lastSegment, parentScope } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import { type FilePrinter, optionFeatures } from "./file-printer.ts"
import { refFqn } from "./oracle.ts"
import { elementComment, tagLine } from "./comments.ts"
import { optionAssignments, withDeprecated } from "./option-values.ts"
import { trySet } from "./annotations.ts"
import { jsonFormatOption } from "./feature-spelling.ts"
import { type FieldSite, fieldHead, printFieldLine } from "./render-field.ts"
import { printEnum } from "./render-enum.ts"
import { printExtensionRanges, printReserved } from "./render-ranges.ts"

type Obj = Record<string, unknown>

/** Groups of consecutive equal keys (extensions of one extendee are printed in one `extend` block). */
const runs = <T>(items: T[], key: (t: T) => string): T[][] => {
  const out: T[][] = []
  for (const it of items) {
    const last = out[out.length - 1]
    if (last && key(last[0]) === key(it)) last.push(it)
    else out.push([it])
  }
  return out
}

/** The proto2 group message a field or extension declares, if it prints as a group (P-1). */
const groupOf = (p: FilePrinter, name: string, f: ProtoApiField, scope: string): string | undefined => {
  if (p.syntax !== "proto2" || !f.delimited) return undefined
  const ref = f.$ref ?? (f.type === "array" && f.items && "$ref" in f.items ? f.items.$ref : undefined)
  if (!ref) return undefined
  const fqn = refFqn(ref)
  if (parentScope(fqn) !== scope || lastSegment(fqn).toLowerCase() !== name) return undefined
  const m = p.ctx.doc.components?.messages?.[fqn]
  if (!m || !p.layout.has(fqn) || p.printed.has(fqn)) return undefined
  return fqn
}

/**
 * Nested messages, extension blocks and (for message bodies) fields of one scope, keeping the order of each
 * (components.messages, components.extensions, properties): a group message is printed by its field or extension,
 * so the nested messages before it are printed first (P-4, P-5).
 */
export const printScope = (
  p: FilePrinter,
  depth: number,
  scope: string,
  children: string[],
  fieldsPart?: (flushBefore: (fqn: string) => void) => void,
) => {
  const exts = p.layout.extensionsIn(scope)
  const extGroups = new Map<string, number>()
  exts.forEach(([k, x], i) => {
    const g = groupOf(p, lastSegment(k), x, scope)
    if (g) extGroups.set(g, i)
  })
  let nextExt = 0
  const flushExts = (through: number) => {
    if (through < nextExt) return
    const slice = exts.slice(nextExt, through + 1)
    nextExt = through + 1
    for (const run of runs(slice, ([, x]) => x.extendee ?? "")) printExtendBlock(p, depth, scope, run)
  }
  let nextChild = 0
  const flushChildren = (until: number) => {
    for (; nextChild < until; nextChild++) {
      const c = children[nextChild]
      if (p.printed.has(c)) continue
      const owner = extGroups.get(c)
      if (owner !== undefined) flushExts(owner)
      else if (!p.fieldGroups.has(c)) printMessage(p, depth, c)
    }
  }
  const flushBefore = (fqn: string) => {
    const i = children.indexOf(fqn)
    if (i >= 0) flushChildren(i)
  }
  fieldsPart?.(flushBefore)
  flushChildren(children.length)
  flushExts(exts.length - 1)
}

/** A field or extension; a proto2 group prints its message's comment and body with the declaration. */
const printField = (p: FilePrinter, depth: number, name: string, f: ProtoApiField, site: FieldSite) => {
  const head = fieldHead(p, f, site)
  const groupMessage = site.groupMessage
  if (!groupMessage) {
    printFieldLine(p, depth, name, f, head)
    return
  }
  // proto2 groups: the comment belongs to the generated message (protoc attaches it there)
  const g = p.ctx.doc.components?.messages?.[groupMessage] as ProtoApiMessage
  p.out.comment(depth, messageComment(p, groupMessage, g))
  const groupName = lastSegment(groupMessage)
  const lbl = site.inOneof ? "" : f.type === "array" ? "repeated " : head.label
  p.out.emit(depth, `${lbl}group ${groupName} = ${f.number}${head.optText} {`)
  p.printed.add(groupMessage)
  messageBody(p, depth + 1, groupMessage, g)
  p.out.emit(depth, "}")
}

const printExtendBlock = (p: FilePrinter, depth: number, scope: string, list: [string, ProtoApiExtension][]) => {
  const extendee = list[0][1].extendee ?? ""
  p.within(scope, () => {
    p.out.emit(depth, `extend ${p.extendeeName(extendee, scope)} {`)
    for (const [k, x] of list) {
      const n = lastSegment(k)
      const ext = { ...x, title: x.title === n ? undefined : x.title }
      printField(p, depth + 1, n, ext, {
        inOneof: false,
        oneofFeatures: undefined,
        extension: true,
        groupMessage: groupOf(p, n, x, scope),
      })
    }
  })
  p.out.emit(depth, "}")
}

/** Message options with the annotation keywords that have a message-level option (openapiv2_schema). */
const messageOptions = (p: FilePrinter, fqn: string, m: ProtoApiMessage): { options: Obj; tags: string[] } => {
  const o = structuredClone(withDeprecated(m))
  const tags: string[] = []
  if (typeof m.title === "string" && m.title !== lastSegment(fqn)) {
    const ok = trySet(p.annotations, o, OPENAPIV2_SCHEMA, ["json_schema", "title"], m.title)
    if (!ok) {
      const t = tagLine(p.ctx.tag, "title", m.title)
      if (t) tags.push(t)
    }
  }
  return { options: o, tags }
}

/** Comment of a message: `@Title` only when openapiv2_schema cannot carry the title. */
const messageComment = (p: FilePrinter, fqn: string, m: ProtoApiMessage): string[] => {
  const { tags } = messageOptions(p, fqn, m)
  return elementComment(p.ctx.tag, { ...m, title: undefined }, undefined, tags)
}

/** The body of message `fqn`, printed in its own scope with its features innermost in the feature chain. */
const messageBody = (p: FilePrinter, depth: number, fqn: string, m: ProtoApiMessage) =>
  p.within(fqn, () => messageMembers(p, depth, fqn, m), { ...optionFeatures(m.options) })

const messageMembers = (p: FilePrinter, depth: number, fqn: string, m: ProtoApiMessage) => {
  const { oracle, tag } = p.ctx
  const out = p.out
  const { options } = messageOptions(p, fqn, m)
  for (const line of optionAssignments(oracle, p.imports, options, "message")) out.emit(depth, `option ${line};`)
  if (p.editions) {
    const jsonFormat = jsonFormatOption(p.features, m.jsonFormat, true)
    if (jsonFormat) out.emit(depth, jsonFormat)
  }
  const properties: Record<string, ProtoApiField> = isPlainObject(m.properties) ? m.properties : {}
  const entries = Object.entries(properties)
  const groups = new Map<string, string>()
  for (const [name, f] of entries) {
    const g = groupOf(p, name, f, fqn)
    if (g) groups.set(name, g)
  }
  p.fieldGroups = new Set(groups.values())
  const children = p.layout.nestedOf(fqn, "messages")
  printScope(p, depth, fqn, children, (flushBefore) => {
    const printedOneofs = new Set<string>()
    for (const [name, f] of entries) {
      if (f.oneof) {
        if (printedOneofs.has(f.oneof)) continue
        printedOneofs.add(f.oneof)
        const members = entries.filter(([, f2]) => f2.oneof === f.oneof)
        for (const [n2] of members) {
          const g = groups.get(n2)
          if (g) flushBefore(g)
        }
        const o = (isPlainObject(m.oneofs) ? m.oneofs[f.oneof] : undefined) ?? {}
        out.comment(depth, elementComment(tag, o, undefined, [], true))
        out.emit(depth, `oneof ${f.oneof} {`)
        for (const line of optionAssignments(oracle, p.imports, o.options as Obj | undefined, "oneof"))
          out.emit(depth + 1, `option ${line};`)
        const oneofFeatures = optionFeatures(o.options)
        for (const [n2, f2] of members)
          printField(p, depth + 1, n2, f2, {
            inOneof: true,
            oneofFeatures,
            extension: false,
            groupMessage: groups.get(n2),
          })
        out.emit(depth, "}")
        continue
      }
      const g = groups.get(name)
      if (g) flushBefore(g)
      printField(p, depth, name, f, { inOneof: false, oneofFeatures: undefined, extension: false, groupMessage: g })
    }
  })
  for (const n of p.layout.nestedOf(fqn, "enums")) printEnum(p, depth, n)
  printReserved(p, depth, m.reserved, false)
  printExtensionRanges(p, depth, m)
}

/** A message (once); a key the document has no message for prints as a wrapper of its nested types. */
export const printMessage = (p: FilePrinter, depth: number, fqn: string) => {
  if (p.printed.has(fqn)) return
  p.printed.add(fqn)
  const m = p.ctx.doc.components?.messages?.[fqn]
  const name = lastSegment(fqn)
  if (!m) {
    // wrapper for nested types whose parent is not in the document
    p.out.emit(depth, `message ${name} {`)
    p.within(fqn, () => {
      printScope(p, depth + 1, fqn, p.layout.nestedOf(fqn, "messages"))
      for (const n of p.layout.nestedOf(fqn, "enums")) printEnum(p, depth + 1, n)
    })
    p.out.emit(depth, "}")
    return
  }
  p.out.comment(depth, messageComment(p, fqn, m))
  const vis = isPlainObject(m.options) ? m.options.visibility : undefined
  p.out.emit(depth, `${vis ? `${vis} ` : ""}message ${name} {`)
  messageBody(p, depth + 1, fqn, m)
  p.out.emit(depth, "}")
}
