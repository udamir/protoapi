// Comment groups of the parser keyed by SourceCodeInfo path, for differential tests against buf images (IN-10).

import { protocGroupText } from "../../src/comments.ts"
import { parseProto } from "../../src/parser/index.ts"
import type * as ast from "../../src/parser/index.ts"

export interface PathComments {
  L?: string
  T?: string
  D?: string[]
}

/** One comment group in SourceCodeInfo text form; a final newline is dropped (buf omits it after a same-line `//` comment, the descriptions are equal). */
const text = (g: ast.CommentGroup): string => protocGroupText(g.comments.map((c) => c.text)).replace(/\n$/, "")

const entry = (s: ast.StatementBase): PathComments => {
  const out: PathComments = {}
  if (s.leadingComments.length) out.L = text(s.leadingComments[0])
  if (s.trailingComments.length) out.T = text(s.trailingComments[0])
  if (s.leadingDetachedComments.length) out.D = s.leadingDetachedComments.map(text)
  return out
}

/** The comments of syntax, package, messages (groups included), fields (oneof members included), oneofs, enums, enum values, services and methods, by SourceCodeInfo path (`4,0,2,1`); statements without comments are left out. */
export function commentsByPath(proto: ast.Proto): Map<string, PathComments> {
  const out = new Map<string, PathComments>()
  const put = (path: number[], s: ast.StatementBase) => {
    const e = entry(s)
    if (e.L !== undefined || e.T !== undefined || e.D) out.set(path.join(), e)
  }
  const message = (path: number[], body: ast.MessageBody) => {
    const n = { field: 0, nested: 0, enum: 0, oneof: 0 }
    for (const s of body.statements) {
      if (s.type === "field" || s.type === "map-field") put([...path, 2, n.field++], s)
      else if (s.type === "group") {
        // the comments of a group belong to its generated message, not to the field
        n.field++
        const p = [...path, 3, n.nested++]
        put(p, s)
        message(p, s.messageBody)
      } else if (s.type === "message") {
        const p = [...path, 3, n.nested++]
        put(p, s)
        message(p, s.messageBody)
      } else if (s.type === "enum") enumBody([...path, 4, n.enum], s, n.enum++)
      else if (s.type === "oneof") {
        put([...path, 8, n.oneof++], s)
        for (const f of s.oneofBody.statements) if (f.type === "oneof-field") put([...path, 2, n.field++], f)
      }
    }
  }
  const enumBody = (path: number[], s: ast.Enum, _i: number) => {
    put(path, s)
    let v = 0
    for (const f of s.enumBody.statements) if (f.type === "enum-field") put([...path, 2, v++], f)
  }
  const n = { message: 0, enum: 0, service: 0 }
  for (const s of proto.statements) {
    if (s.type === "syntax" || s.type === "edition") put([12], s)
    else if (s.type === "package") put([2], s)
    else if (s.type === "message") {
      const p = [4, n.message++]
      put(p, s)
      message(p, s.messageBody)
    } else if (s.type === "enum") enumBody([5, n.enum], s, n.enum++)
    else if (s.type === "service") {
      const p = [6, n.service++]
      put(p, s)
      let r = 0
      for (const m of s.serviceBody.statements) if (m.type === "rpc") put([...p, 2, r++], m)
    }
  }
  return out
}

export interface SciLocation {
  path?: number[]
  leadingComments?: string
  trailingComments?: string
  leadingDetachedComments?: string[]
}

/** The same view of a buf-built file's SourceCodeInfo, for the paths `commentsByPath` covers. */
export function sciByPath(locations: SciLocation[], paths: (path: number[]) => boolean): Map<string, PathComments> {
  const out = new Map<string, PathComments>()
  for (const l of locations) {
    const path = l.path ?? []
    if (!paths(path)) continue
    const e: PathComments = {}
    if (l.leadingComments !== undefined) e.L = l.leadingComments.replace(/\n$/, "")
    if (l.trailingComments !== undefined) e.T = l.trailingComments.replace(/\n$/, "")
    if (l.leadingDetachedComments?.length) e.D = l.leadingDetachedComments.map((d) => d.replace(/\n$/, ""))
    if (e.L !== undefined || e.T !== undefined || e.D) out.set(path.join(), e)
  }
  return out
}

/** Whether a path names an element `commentsByPath` reports (not one of its parts such as a name or a type). */
export function isElementPath(path: number[]): boolean {
  if (path.length === 1) return path[0] === 12 || path[0] === 2
  if (path.length % 2) return false
  const top = path[0]
  if (top === 6) return path.length === 2 || (path.length === 4 && path[2] === 2)
  if (top !== 4 && top !== 5) return false
  for (let i = 2; i < path.length; i += 2) {
    const tag = path[i]
    const parentIsEnum = (i === 2 && top === 5) || (i >= 4 && path[i - 2] === 4)
    if (parentIsEnum ? tag !== 2 : ![2, 3, 4, 8].includes(tag)) return false
    if (tag === 2 && i < path.length - 2) return false
  }
  return true
}

/** Differences between the parser's comment groups for `text` and a buf build's SourceCodeInfo of it (`path: ours … buf …`). */
export function compareComments(text: string, locations: SciLocation[]): string[] {
  const ours = commentsByPath(parseProto(text).ast)
  const theirs = sciByPath(locations, isElementPath)
  const out: string[] = []
  for (const k of new Set([...ours.keys(), ...theirs.keys()])) {
    const a = JSON.stringify(ours.get(k) ?? {})
    const b = JSON.stringify(theirs.get(k) ?? {})
    if (a !== b) out.push(`${k}: ours ${a} buf ${b}`)
  }
  return out
}
