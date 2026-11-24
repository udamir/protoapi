// Where components are printed: the file of each component (from `files` and `file`, or for documents without `files` by package, decision 12), the syntax of such files, and the nesting of components inside one file.

import type { ProtoApiDocument, ProtoApiExtension, ProtoApiFile, ProtoSyntax } from "../types.ts"
import { lastSegment, parentScope } from "../common/names.ts"
import { isPlainObject } from "../common/objects.ts"
import { bundleIndex } from "./oracle.ts"

/** Component key -> file it is printed in, and the files of the document (or of the printed output). */
export interface Placement {
  placement: Map<string, string>
  files: Record<string, ProtoApiFile>
}

/** Placement of a document with `files`: a component's `file` when the document has it, else the first file that is not `bundled`. */
export const placeWithFiles = (doc: ProtoApiDocument, docFiles: Record<string, ProtoApiFile>): Placement => {
  const placement = new Map<string, string>()
  const files: Record<string, ProtoApiFile> = {}
  for (const [p, f] of Object.entries(docFiles)) files[p] = isPlainObject(f) ? f : {}
  const first = Object.keys(files).find((p) => !files[p].bundled) ?? Object.keys(files)[0]
  const place = (key: string, c: unknown) => {
    const file = isPlainObject(c) && typeof c.file === "string" && c.file in files ? c.file : first
    placement.set(key, file)
  }
  for (const k of ["messages", "enums", "extensions"] as const)
    for (const [key, c] of Object.entries(doc.components?.[k] ?? {})) place(key, c)
  for (const [key, s] of Object.entries(doc.services ?? {})) place(key, s)
  return { placement, files }
}

// ---- documents without `files` (decision 12) -------------------------------------------------------------------------

/**
 * Syntax of printed content without a `syntax` (decision 12): features -> 2023 (visibility -> 2024), proto2 constructs
 * (`required`, defaults, groups, extension ranges, closed enums, the proto2 resolved features) -> proto2, else proto3.
 * Read from the JSON text of the elements; keywords inside option values do not count.
 */
export const inferSyntax = (doc: ProtoApiDocument, include: (key: string) => boolean): ProtoSyntax => {
  const parts: unknown[] = []
  for (const group of [doc.components?.messages, doc.components?.enums, doc.components?.extensions, doc.services])
    for (const [k, v] of Object.entries(group ?? {})) if (include(k)) parts.push(v)
  const all = JSON.stringify(parts)
  const own = JSON.stringify(parts, (k, v) => (k === "options" ? undefined : v))
  return /"visibility":/.test(all)
    ? "2024"
    : /"features":/.test(all)
      ? "2023"
      : /"presence":"required"|"default":[^{]|"delimited":true|"jsonFormat":"|"closed":true|"utf8Validation":false|"packed":false|"extensions":\[\[/.test(
            own,
          )
        ? "proto2"
        : "proto3"
}

/**
 * Placement of the components of a document without `files` (decision 12): types the bundle declares are imported, the
 * rest is printed in `fileName` with the longest common package prefix of the keys as the package; a document whose
 * keys lie in several packages gets one file per package (`<package path>/<fileName>` after the first).
 */
export const placeWithoutFiles = (
  doc: ProtoApiDocument,
  fileName: string,
  bundle: Readonly<Record<string, string>>,
): Placement => {
  const placement = new Map<string, string>()
  const c = doc.components ?? {}
  const msgs = c.messages ?? {}
  const index = bundleIndex(bundle)
  const imports = new Set<string>()
  const byPackage = new Map<string, string[]>()
  for (const group of [c.messages, c.enums, c.extensions, doc.services])
    for (const key of Object.keys(group ?? {})) {
      const b = group === c.messages || group === c.enums ? index.get(key) : undefined
      if (b) {
        imports.add(b)
        placement.set(key, b)
        continue
      }
      // the package of a key: its parents that are messages (or look like ones) are not part of it
      let k = key
      while (parentScope(k) && (msgs[parentScope(k)] || /^[A-Z]/.test(lastSegment(parentScope(k))))) k = parentScope(k)
      const pkg = parentScope(k)
      byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), key])
    }
  const files: Record<string, ProtoApiFile> = {}
  const packages = byPackage.size ? [...byPackage.keys()] : [""]
  packages.forEach((pkg, i) => {
    const path = i ? `${pkg.split(".").join("/")}/${fileName}` : fileName
    for (const key of byPackage.get(pkg) ?? []) placement.set(key, path)
    files[path] = { ...(pkg ? { package: pkg } : {}), imports: [...imports] }
  })
  for (const [path, f] of Object.entries(files)) f.syntax = inferSyntax(doc, (k) => placement.get(k) === path)
  return { placement, files }
}

// ---- nesting inside one file ------------------------------------------------------------------------------------------

/** The components of one printed file and how they nest: parents, nested types, top-level messages, extension scopes. */
export class FileLayout {
  private readonly doc: ProtoApiDocument
  private readonly placement: Map<string, string>
  private readonly path: string
  private readonly pkg: string
  /** nested message / enum keys by parent message, filled on first use */
  private children?: Record<"messages" | "enums", Map<string, string[]>>

  constructor(doc: ProtoApiDocument, placement: Map<string, string>, path: string, pkg: string | undefined) {
    this.doc = doc
    this.placement = placement
    this.path = path
    this.pkg = pkg ?? ""
  }

  /** Whether component `key` is printed in this file. */
  has(key: string): boolean {
    return this.placement.get(key) === this.path
  }

  /** The message a component is nested in (undefined at top level); missing parents become wrapper messages. */
  parentMessage(key: string): string | undefined {
    const pkg = this.pkg
    const parent = parentScope(key)
    if (!parent || parent === pkg || (pkg && !key.startsWith(`${pkg}.`))) return undefined
    return parent
  }

  /** The messages or enums of this file nested directly in `fqn`, in document order. */
  nestedOf(fqn: string, kind: "messages" | "enums"): string[] {
    if (!this.children) {
      const children: Record<"messages" | "enums", Map<string, string[]>> = { messages: new Map(), enums: new Map() }
      this.children = children
      for (const k of ["messages", "enums"] as const) {
        const comps = this.doc.components?.[k] ?? {}
        for (const key of Object.keys(comps)) {
          if (!this.has(key)) continue
          const parent = this.parentMessage(key)
          if (parent === undefined) continue
          const list = children[k].get(parent)
          if (list) list.push(key)
          else children[k].set(parent, [key])
        }
      }
    }
    return this.children[kind].get(fqn) ?? []
  }

  /** Top-level message keys of this file, with wrapper messages for nested types (and extensions) whose parent
   *  message is missing (D3 emits referenced types only): a wrapper message keeps their fully qualified names. */
  topLevel(): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const msgs = this.doc.components?.messages ?? {}
    const add = (key: string) => {
      const parent = this.parentMessage(key)
      if (parent === undefined) {
        if (!seen.has(key)) {
          seen.add(key)
          out.push(key)
        }
        return
      }
      if (!msgs[parent] || !this.has(parent)) add(parent)
    }
    for (const k of ["messages", "enums", "extensions"] as const)
      for (const key of Object.keys(this.doc.components?.[k] ?? {}))
        if (this.has(key) && (k === "messages" || this.parentMessage(key) !== undefined)) add(key)
    return out
  }

  /** Extensions declared in `scope` (a message, a wrapper or the package), in document order. */
  extensionsIn(scope: string): [string, ProtoApiExtension][] {
    const out: [string, ProtoApiExtension][] = []
    for (const [k, x] of Object.entries(this.doc.components?.extensions ?? {})) {
      if (!this.has(k) || !isPlainObject(x)) continue
      // extensions outside the file's package can only be printed at file level
      const s = this.parentMessage(k) ?? this.pkg
      if (s === scope) out.push([k, x])
    }
    return out
  }
}
