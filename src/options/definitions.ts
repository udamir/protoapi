// Definition lookups of the interpreter: the value type of a field, fields by name or ProtoJSON key, extensions.

import type { MField, MMessage } from "../model/index.ts"
import type { SymbolTable } from "../symbols.ts"
import { lowerCamel } from "../values/json-name.ts"
import type { VType } from "./scalar.ts"

/** The value type of a type reference (a field's type, a map's value type). */
export const refType = (t: MField["type"] | undefined, symbols: SymbolTable): VType => {
  if (t?.kind === "scalar") return { kind: "scalar", scalar: t.scalar }
  const r = t?.resolved
  if (r?.kind === "enum") return { kind: "enum", def: symbols.enum(r.fqn) }
  if (r?.kind === "message") return { kind: "message", def: symbols.message(r.fqn), fqn: r.fqn }
  return { kind: "unknown" }
}

export const typeOfRef = (field: MField, symbols: SymbolTable): VType => refType(field.type, symbols)

export const mapValueType = (field: MField, symbols: SymbolTable): VType => refType(field.map?.value, symbols)

export const fieldByName = (def: MMessage, name: string): MField | undefined => def.fields.find((f) => f.name === name)

export const fieldByJsonKey = (def: MMessage, key: string): MField | undefined =>
  def.fields.find((f) => f.name === key) ?? def.fields.find((f) => (f.jsonName ?? lowerCamel(f.name)) === key)

export const extensionOf = (symbols: SymbolTable, extendee: string, fqn: string): MField | undefined => {
  const e = symbols.extensionByName.get(fqn)
  if (!e || e.field.extendee?.resolved !== extendee) return undefined
  return e.field
}

/** The key of the field or extension of `def` with number `num`: the field name or the extension's fqn. */
export const keyByNumber = (symbols: SymbolTable, def: MMessage, num: number): string | undefined => {
  const f = def.fields.find((x) => x.number === num)
  if (f) return f.name
  for (const x of symbols.extensionsByExtendee.get(def.fqn) ?? []) if (x.number === num) return x.fqn
  return undefined
}
