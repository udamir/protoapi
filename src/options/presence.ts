// Presence of option fields (C-14): which values equal an absent one and are therefore not written.

import type { MField, MMessage, MOptionHolder } from "../model.ts"
import type { SymbolTable } from "../symbols.ts"
import { isPlainObject } from "../common/objects.ts"
import { INT64_KINDS } from "../values/scalars.ts"

/**
 * Whether a field of an option message (or of an option value's type) has implicit presence: a singular scalar or
 * enum field of a proto3 file without `optional`, or of an editions file where `features.field_presence = IMPLICIT`
 * is set on the field, an enclosing message or the file. Such a field set to its zero value is never serialized, so
 * the value is the same as an absent one (C-14). Editions features are read from ProtoJSON or interpreted options.
 */
const implicitPresence = (f: MField, def: MMessage): boolean => {
  if (f.repeated || f.map || f.oneof !== undefined || f.fqn !== undefined) return false
  if (f.type.kind === "named" && f.type.resolved?.kind !== "enum") return false
  const syntax = def.file.syntax
  if (syntax === "proto2") return false
  if (syntax === "proto3") return !f.optional
  const presence = (h: MOptionHolder): unknown => {
    const typed = isPlainObject(h.options.features) ? h.options.features.field_presence : undefined
    if (typed !== undefined) return typed
    for (const raw of h.raw) {
      if (raw.kind !== "json") continue
      const fs = raw.value.features
      const v = isPlainObject(fs) ? (fs.fieldPresence ?? fs.field_presence) : undefined
      if (v !== undefined) return v === 2 ? "IMPLICIT" : v
    }
    return undefined
  }
  const own = presence(f)
  if (own !== undefined) return own === "IMPLICIT"
  // enclosing messages, innermost first, then the file
  const chain: MOptionHolder[] = []
  const find = (ms: MMessage[], path: MMessage[]): boolean => {
    for (const m of ms) {
      if (m === def) {
        chain.push(...[...path, m].reverse())
        return true
      }
      if (find(m.nested, [...path, m])) return true
    }
    return false
  }
  find(def.file.messages, [])
  for (const h of [...chain, def.file]) {
    const v = presence(h)
    if (v !== undefined) return v === "IMPLICIT"
  }
  return false
}

/** The canonical zero value test for a field of type `f` (proto3 implicit-presence rule). */
const isZeroValue = (v: unknown, f: MField, symbols: SymbolTable): boolean => {
  const t = f.type
  if (t.kind === "scalar") {
    const s = t.scalar
    if (s === "string" || s === "bytes") return v === ""
    if (s === "bool") return v === false
    if (INT64_KINDS.has(s)) return v === "0" || v === 0
    return v === 0 && !Object.is(v, -0)
  }
  if (t.resolved?.kind === "enum") {
    if (v === 0) return true
    const e = symbols.enum(t.resolved.fqn)
    return typeof v === "string" && e?.values.find((x) => x.name === v)?.number === 0
  }
  return false
}

/** An option value that equals an absent one: an empty repeated or map field, or an implicit-presence zero (C-14). */
export const isAbsentValue = (v: unknown, f: MField, def: MMessage, symbols: SymbolTable): boolean => {
  if (f.repeated || f.map) return Array.isArray(v) ? v.length === 0 : isPlainObject(v) && Object.keys(v).length === 0
  return implicitPresence(f, def) && isZeroValue(v, f, symbols)
}
