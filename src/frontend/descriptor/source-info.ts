// SourceCodeInfo of a FileDescriptorProto (ProtoJSON): a trie over the location paths, read as element locations and
// comments, and the parts of each element (descriptor field numbers, see src/common/descriptor-fields.ts).

import type { Location } from "../../types.ts"
import type { Locs, MComments } from "../../model/index.ts"
import { ENUM, ENUM_VALUE, FIELD, FILE, MESSAGE, METHOD, ONEOF, SERVICE } from "../../common/descriptor-fields.ts"
import { type Json, arr, get, list, numbers, str } from "./json.ts"

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

/** Parts of an element: location key -> child field number of its descriptor. */
export type Parts = Record<string, number>
export const FIELD_PARTS: Parts = {
  name: FIELD.name,
  extendee: FIELD.extendee,
  number: FIELD.number,
  label: FIELD.label,
  typeKind: FIELD.type,
  type: FIELD.typeName,
  default: FIELD.defaultValue,
  jsonName: FIELD.jsonName,
}
export const ONEOF_PARTS: Parts = { name: ONEOF.name }
export const SERVICE_PARTS: Parts = { name: SERVICE.name }
export const VALUE_PARTS: Parts = { name: ENUM_VALUE.name, number: ENUM_VALUE.number }
export const ENUM_PARTS: Parts = { name: ENUM.name, reserved: ENUM.reservedRange, reservedNames: ENUM.reservedName }
export const MESSAGE_PARTS: Parts = {
  name: MESSAGE.name,
  extensions: MESSAGE.extensionRange,
  reserved: MESSAGE.reservedRange,
  reservedNames: MESSAGE.reservedName,
}
export const METHOD_PARTS: Parts = {
  name: METHOD.name,
  request: METHOD.inputType,
  response: METHOD.outputType,
  "request/stream": METHOD.clientStreaming,
  "response/stream": METHOD.serverStreaming,
}
export const FILE_PARTS: Parts = { syntax: FILE.syntax, package: FILE.package, edition: FILE.edition }

export class SourceIndex {
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

  /** The detached comments of the file header (spec §3.3): those of `syntax` / `edition`, else of the location that starts first in the file, preferring one with detached comments. */
  header(): string[] {
    let first = this.node([FILE.syntax])?.loc ?? this.node([FILE.edition])?.loc
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
