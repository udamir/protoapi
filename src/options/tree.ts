// The canonical option tree: key order by definition, and the raw-value helpers for values without a definition.

import type { MField, MMessage } from "../model/index.ts"
import type { SymbolTable } from "../symbols.ts"
import { getKey, hasKey, isPlainObject, setKey } from "../common/objects.ts"
import { toSnake } from "../values/json-name.ts"

/** Order keys by definition: fields in declaration order, then extensions by number, then unknown keys. */
export const orderTree = (
  tree: Record<string, unknown>,
  def: MMessage | undefined,
  symbols: SymbolTable,
): Record<string, unknown> => {
  if (!def) return tree
  const out: Record<string, unknown> = {}
  const childType = (f: MField): MMessage | undefined => {
    const t = f.map ? f.map.value : f.type
    return t.kind === "named" && t.resolved?.kind === "message" ? symbols.message(t.resolved.fqn) : undefined
  }
  const orderValue = (v: unknown, f: MField): unknown => {
    const child = childType(f)
    if (f.map && isPlainObject(v)) {
      const m: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort())
        setKey(m, k, child && isPlainObject(v[k]) ? orderTree(v[k] as Record<string, unknown>, child, symbols) : v[k])
      return m
    }
    if (!child) return v
    if (Array.isArray(v)) return v.map((x) => (isPlainObject(x) ? orderTree(x, child, symbols) : x))
    return isPlainObject(v) ? orderTree(v, child, symbols) : v
  }
  // an expanded Any (spec §3.6): `@type` first, then the payload in its own order
  if (hasKey(tree, "@type") && def.fqn === "google.protobuf.Any") out["@type"] = tree["@type"]
  for (const f of def.fields) if (hasKey(tree, f.name)) setKey(out, f.name, orderValue(tree[f.name], f))
  const exts = (symbols.extensionsByExtendee.get(def.fqn) ?? [])
    .map((f) => ({ f, fqn: f.fqn }))
    .filter((e): e is { f: MField; fqn: string } => !!e.fqn && hasKey(tree, e.fqn))
    .sort((a, b) => a.f.number - b.f.number || a.fqn.localeCompare(b.fqn))
  for (const { f, fqn } of exts) setKey(out, fqn, orderValue(tree[fqn], f))
  for (const k of Object.keys(tree)) if (!hasKey(out, k)) setKey(out, k, tree[k])
  return out
}

/** Merge `b` into `a`: objects recursively, arrays appended, other values replaced. */
export const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(b)) {
    const old = getKey(a, k)
    if (isPlainObject(old) && isPlainObject(v)) deepMerge(old, v)
    else if (Array.isArray(old) && Array.isArray(v)) old.push(...v)
    else setKey(a, k, v)
  }
}

/** Add a raw value under `key`; a key set again becomes an array (a repeated field written twice). */
export const addRaw = (out: Record<string, unknown>, key: string, value: unknown) => {
  if (!hasKey(out, key)) setKey(out, key, value)
  else if (Array.isArray(out[key])) (out[key] as unknown[]).push(value)
  else out[key] = [out[key], value]
}

/** Set a raw value at a key path, creating objects on the way (for fields kept raw, spec §3.7). */
export const setRaw = (tree: Record<string, unknown>, keys: string[], value: unknown) => {
  let cur = tree
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(getKey(cur, k))) setKey(cur, k, {})
    cur = cur[k] as Record<string, unknown>
  }
  addRaw(cur, keys[keys.length - 1], value)
}

/** ProtoJSON keys of a value without a definition converted by the generic rule (lowerCamelCase -> snake_case). */
export const snakeKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(snakeKeys)
  if (!isPlainObject(v)) return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) setKey(out, /^\[.+\]$/.test(k) ? k.slice(1, -1) : toSnake(k), snakeKeys(x))
  return out
}
