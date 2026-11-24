// Features in the spelling of the printed file's syntax: the editions features a field, message or enum prints when it differs from what it inherits, and the resolved keywords (packed, utf8Validation) in proto2 / proto3 / editions.

import type { ProtoApiField, ProtoSyntax } from "../types.ts"
import { isEditions } from "../common/editions.ts"
import { scalarOf } from "./oracle.ts"

type Obj = Record<string, unknown>

/** The features objects of the file and the enclosing messages, outermost first. */
export class FeatureChain {
  private readonly chain: (Obj | undefined)[]

  constructor(fileFeatures: Obj | undefined) {
    this.chain = [fileFeatures]
  }

  push(features: Obj): void {
    this.chain.push(features)
  }

  pop(): void {
    this.chain.pop()
  }

  /** Inherited value of an editions feature for the current element (file, enclosing messages, `extra`). */
  inherited(name: string, extra?: Obj): unknown {
    let v: unknown
    for (const f of this.chain) if (f && f[name] !== undefined) v = f[name]
    if (extra && extra[name] !== undefined) v = extra[name]
    return v
  }

  /** Record the `json_format` the innermost message prints, for its nested types. */
  setJsonFormat(value: string): void {
    const top = this.chain[this.chain.length - 1]
    if (top) top.json_format = value
  }
}

/** `features.field_presence` of a singular editions field outside a oneof, when it differs from the inherited value. */
export const presenceFeature = (
  features: FeatureChain,
  f: ProtoApiField,
  isMessageRef: boolean,
  oneofFeatures: Obj | undefined,
): string | undefined => {
  const inherited = (features.inherited("field_presence", oneofFeatures) as string | undefined) ?? "EXPLICIT"
  const want =
    f.presence === "required" ? "LEGACY_REQUIRED" : f.presence === "explicit" || isMessageRef ? "EXPLICIT" : "IMPLICIT"
  return want !== inherited && !(isMessageRef && want === "EXPLICIT") ? `features.field_presence = ${want}` : undefined
}

/** `features.message_encoding` of a message-typed editions field, when it differs from the inherited value. */
export const messageEncodingFeature = (
  features: FeatureChain,
  f: ProtoApiField,
  oneofFeatures: Obj | undefined,
): string | undefined => {
  const inherited = (features.inherited("message_encoding", oneofFeatures) as string | undefined) ?? "LENGTH_PREFIXED"
  const want = f.delimited ? "DELIMITED" : "LENGTH_PREFIXED"
  return want !== inherited ? `features.message_encoding = ${want}` : undefined
}

/**
 * The resolved keywords `packed: false` and `utf8Validation: false` (spec §3.5 rule D) in the spelling of the syntax: proto2 prints `[packed = true]` when `packed` is absent (its default is EXPANDED), proto3 `[packed = false]`, editions `features.repeated_field_encoding = EXPANDED` / `features.utf8_validation = NONE` (files and messages never carry these features, so the edition defaults PACKED and VERIFY apply).
 */
export const resolvedFeatureOptions = (f: ProtoApiField, syntax: ProtoSyntax): string[] => {
  const editions = isEditions(syntax)
  const out: string[] = []
  const items = f.type === "array" ? f.items : undefined
  const packable =
    !!items &&
    (scalarOf(items)
      ? scalarOf(items) !== "string" && scalarOf(items) !== "bytes"
      : "$ref" in items && !!items.$ref?.includes("/enums/"))
  if (packable) {
    if (syntax === "proto2" && f.packed !== false) out.push("packed = true")
    else if (syntax === "proto3" && f.packed === false) out.push("packed = false")
    else if (editions && f.packed === false) out.push("features.repeated_field_encoding = EXPANDED")
  }
  const noUtf8 = (r: unknown) => !!r && (r as { utf8Validation?: boolean }).utf8Validation === false
  if (
    editions &&
    (f.utf8Validation === false || noUtf8(items) || noUtf8(f.propertyNames) || noUtf8(f.additionalProperties))
  )
    out.push("features.utf8_validation = NONE")
  return out
}

/** `jsonFormat` (spec §3.5 rule D) in editions: the feature option when it differs from the value the element inherits from the printed file and enclosing messages (absent means ALLOW). A message records what it prints for its nested types. */
export const jsonFormatOption = (
  features: FeatureChain,
  jsonFormat: string | undefined,
  message: boolean,
): string | undefined => {
  const want = jsonFormat ?? "ALLOW"
  const inherited = (features.inherited("json_format") as string | undefined) ?? "ALLOW"
  if (message) features.setJsonFormat(want)
  return want !== inherited ? `option features.json_format = ${want};` : undefined
}

/** `features.enum_type` of an editions enum when it differs from the inherited value (absent means OPEN). */
export const enumTypeOption = (features: FeatureChain, closed: boolean | undefined): string | undefined => {
  const inherited = (features.inherited("enum_type") as string | undefined) ?? "OPEN"
  const want = closed ? "CLOSED" : "OPEN"
  return want !== inherited ? `option features.enum_type = ${want};` : undefined
}
