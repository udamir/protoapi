// Option values in text format (scalars, aggregates, maps, expanded `Any`) and the `name = value` assignments of an element's options tree; extension options and extension features need the import of their declaring file.

import type { ProtoApiElement } from "../types.ts"
import { OPTIONS_MESSAGE } from "../options/kinds.ts"
import { WKT_VALUE_FORM, fromWktJson } from "../options/wkt.ts"
import { isPlainObject } from "../common/objects.ts"
import type { FType, Oracle } from "./oracle.ts"
import type { ImportTracker } from "./imports.ts"
import { scalarLit } from "./literals.ts"

type Obj = Record<string, unknown>

/** Text-format value for an option of type `t`. */
export const valueText = (oracle: Oracle, v: unknown, t: FType | undefined): string => {
  if (t?.kind === "message" && t.map && isPlainObject(v)) {
    const key: FType = { kind: "scalar", scalar: t.map.key }
    const value = t.map.value
    return `[${Object.entries(v)
      .map(
        ([k, x]) =>
          `{ key: ${scalarLit(key.scalar === "bool" ? k === "true" : k, key)} value: ${valueText(oracle, x, value)} }`,
      )
      .join(", ")}]`
  }
  if (
    isPlainObject(v) &&
    typeof v["@type"] === "string" &&
    (!t || (t.kind === "message" && t.fqn === "google.protobuf.Any"))
  )
    return anyText(oracle, v)
  if (t?.kind === "message" && isPlainObject(v)) return aggregate(oracle, v, t.fqn)
  if (isPlainObject(v)) return aggregate(oracle, v, "")
  if (Array.isArray(v))
    return `[${v.map((x) => valueText(oracle, x, t ? ({ ...t, repeated: false } as FType) : undefined)).join(", ")}]`
  return scalarLit(v, t)
}

/** An `Any` in its ProtoJSON form (`{ "@type": url, … }`) as the expanded text form `{ [url] { … } }`. */
const anyText = (oracle: Oracle, v: Obj): string => {
  const url = String(v["@type"])
  const fqn = url.slice(url.lastIndexOf("/") + 1)
  if (fqn === "google.protobuf.Any" && isPlainObject(v.value)) return `{ [${url}] ${anyText(oracle, v.value)} }`
  let payload: Obj | undefined
  if (WKT_VALUE_FORM.has(fqn)) payload = fromWktJson(fqn, v.value) as Obj | undefined
  if (!payload) {
    payload = { ...v }
    delete payload["@type"]
  }
  return `{ [${url}] ${aggregate(oracle, payload, oracle.hasMessage(fqn) ? fqn : "")} }`
}

/** A message value `{ name: value … }`, typed by message `fqn` when it is known (`""`: untyped). */
export const aggregate = (oracle: Oracle, v: Obj, fqn: string): string => {
  const parts: string[] = []
  for (const [k, x] of Object.entries(v)) {
    const t = fqn ? oracle.field(fqn, k) : undefined
    const name = k.includes("/") || (fqn ? oracle.isExtension(fqn, k) : k.includes(".")) ? `[${k}]` : k
    const single = t ? ({ ...t, repeated: false } as FType) : undefined
    if (Array.isArray(x)) parts.push(`${name}: [${x.map((y) => valueText(oracle, y, single)).join(", ")}]`)
    else if (isPlainObject(x) && !(t && "map" in t && t.map)) parts.push(`${name} ${valueText(oracle, x, single)}`)
    else parts.push(`${name}: ${valueText(oracle, x, single)}`)
  }
  return parts.length ? `{ ${parts.join(" ")} }` : "{}"
}

/** Option assignments `name = value` for an element's options tree (kind = options message). */
export const optionAssignments = (
  oracle: Oracle,
  imports: ImportTracker,
  options: Obj | undefined,
  kind: keyof typeof OPTIONS_MESSAGE,
): string[] => {
  if (!options || !isPlainObject(options)) return []
  const optFqn = OPTIONS_MESSAGE[kind]
  const out: string[] = []
  const push = (name: string, v: unknown, t: FType | undefined) => {
    if (Array.isArray(v))
      for (const x of v)
        out.push(`${name} = ${valueText(oracle, x, t ? ({ ...t, repeated: false } as FType) : undefined)}`)
    else out.push(`${name} = ${valueText(oracle, v, t)}`)
  }
  for (const [key, v] of Object.entries(options)) {
    if (key === "visibility" || key === "extension_declarations" || v === undefined || (Array.isArray(v) && !v.length))
      continue
    const t = oracle.field(optFqn, key)
    const isExt = oracle.isExtension(optFqn, key)
    const name = isExt ? `(${key})` : key
    if (!t && (typeof v === "string" || isPlainObject(v))) {
      // an unknown option: the source text as written, a sub-path (`(unk.sub).x`) from nested keys
      const raw = (path: string, x: unknown): unknown =>
        isPlainObject(x)
          ? Object.entries(x).forEach(([k, y]) => raw(`${path}.${k}`, y))
          : (Array.isArray(x) ? x : [x]).forEach((y) => out.push(`${path} = ${y}`))
      raw(`(${key})`, v)
      continue
    }
    if (key === "features" && isPlainObject(v)) {
      const flat = (prefix: string, obj: Obj, fqn: string) => {
        for (const [fk, fv] of Object.entries(obj)) {
          const ft = oracle.field(fqn, fk)
          const ext = oracle.isExtension(fqn, fk)
          const seg = ext ? `(${fk})` : fk
          if (ext) imports.need(oracle.extensionFile(fk))
          if (isPlainObject(fv) && ft?.kind === "message") flat(`${prefix}.${seg}`, fv, ft.fqn)
          else push(`${prefix}.${seg}`, fv, ft)
        }
      }
      flat("features", v, "google.protobuf.FeatureSet")
      continue
    }
    if (isExt) imports.need(oracle.extensionFile(key))
    push(name, v, t)
  }
  return out
}

/** An element's options with `deprecated = true` when it is deprecated (the built-in option the keyword lifts). */
export const withDeprecated = (e: ProtoApiElement): Obj => ({
  ...(e.deprecation ? { deprecated: true } : {}),
  ...(isPlainObject(e.options) ? e.options : {}),
})
