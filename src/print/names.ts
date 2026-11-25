// Type names in the printed text: the names a document knows (and, for extendees and method types, its members too), protoc's name lookup, the shortest name that resolves back to a type from a scope, and the spelling of unresolved references.

import type { ProtoApiDocument, ProtoApiFile } from "../types.ts"
import { parentScope, qualify } from "../common/names.ts"
import type { Oracle } from "./oracle.ts"

/** Fully qualified names of every type and package the document (and the definitions) know; with `members`, also the document's fields, oneofs, enum values (siblings of their enum), extensions and methods, which only protoc's any-kind lookups see (extendees and method types: the first symbol of any kind wins, the wrong kind is an error). */
export const symbolNames = (
  doc: ProtoApiDocument,
  oracle: Oracle,
  files: Record<string, ProtoApiFile>,
  members?: boolean,
): Set<string> => {
  const out = new Set<string>()
  const add = (scope: string, o: unknown) => {
    if (members) for (const n in o as object) out.add(qualify(scope, n))
  }
  add("", doc.components?.extensions)
  for (const [k, m] of Object.entries(doc.components?.messages ?? {})) {
    out.add(k)
    add(k, m?.properties)
    add(k, m?.oneofs)
  }
  for (const [k, e] of Object.entries(doc.components?.enums ?? {})) {
    out.add(k)
    add(parentScope(k), e?.values)
  }
  for (const [k, s] of Object.entries(doc.services ?? {})) {
    out.add(k)
    // a method name hides a type of the same name in the service's scope (buf: "expected message type, found service method")
    add(k, s?.methods)
  }
  for (const f of Object.values(files)) {
    const parts = (typeof f?.package === "string" ? f.package : "").split(".").filter(Boolean)
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("."))
  }
  for (const k of oracle.knownNames()) out.add(k)
  // packages implied by component keys
  for (const k of [...out]) {
    const parts = k.split(".")
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."))
  }
  return out
}

/** protoc's lookup over a set of names (first component innermost-out, remainder inside the match). */
const lookupName = (name: string, scope: string, names: Set<string>): string | undefined => {
  const dot = name.indexOf(".")
  const first = dot < 0 ? name : name.slice(0, dot)
  let current = scope
  while (true) {
    const candidate = qualify(current, first)
    if (names.has(candidate)) {
      const full = qualify(current, name)
      return names.has(full) ? full : undefined
    }
    if (!current) return undefined
    const i = current.lastIndexOf(".")
    current = i < 0 ? "" : current.slice(0, i)
  }
}

/** Shortest suffix of `fqn` that resolves back to `fqn` from `scope`; else the absolute `.fqn`. */
export const shortestName = (fqn: string, scope: string, names: Set<string>): string => {
  const parts = fqn.split(".")
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts.slice(i).join(".")
    if (lookupName(candidate, scope, names) === fqn) return candidate
  }
  return `.${fqn}`
}

/** A name the document does not declare (an unresolved reference) in a file of package `pkg`: spelled so that the builder's best-effort key (`unresolvedKey`: dotted names as written, simple names in the package) is the same key again. */
export const unresolvedName = (fqn: string, pkg: string | undefined): string => {
  const rest = pkg && fqn.startsWith(`${pkg}.`) ? fqn.slice(pkg.length + 1) : "."
  return rest.includes(".") ? fqn : rest
}
