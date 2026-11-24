// Field and extension declarations: label, type, number and the `[…]` options (built-in options, features in the spelling of the syntax, convention options from the annotation plan), with the field's comment. Fields that print as proto2 groups are finished by render-message.

import type { ProtoApiField } from "../types.ts"
import type { FilePrinter } from "./file-printer.ts"
import { type FType, scalarOf } from "./oracle.ts"
import { quote, scalarLit } from "./literals.ts"
import { optionAssignments } from "./option-values.ts"
import { type FieldPlan, planField } from "./annotations.ts"
import { fieldComment } from "./comments.ts"
import { messageEncodingFeature, presenceFeature, resolvedFeatureOptions } from "./feature-spelling.ts"

type Obj = Record<string, unknown>

/** Where a field is declared. */
export interface FieldSite {
  inOneof: boolean
  /** features of the enclosing oneof */
  oneofFeatures: Obj | undefined
  extension: boolean
  /** the group message the field declares (proto2 groups) */
  groupMessage?: string
}

/** What a field declaration prints before its type: the label, the `[…]` option text and the annotation plan. */
export interface FieldHead {
  label: string
  optText: string
  plan: FieldPlan
}

/** The label and options of field `f`; imports its options need are added in the order the options are printed. */
export const fieldHead = (p: FilePrinter, f: ProtoApiField, site: FieldSite): FieldHead => {
  const { inOneof, oneofFeatures, extension, groupMessage } = site
  const syntax = p.syntax
  const opts: string[] = []
  if (f.deprecation) opts.push("deprecated = true")
  if (f.jsonName !== undefined && !extension) opts.push(`json_name = ${quote(f.jsonName)}`)
  const scalar = scalarOf(f)
  const valueType: FType | undefined = scalar
    ? { kind: "scalar", scalar }
    : f.$ref?.includes("/enums/")
      ? { kind: "enum" }
      : undefined
  if (f.default !== undefined) opts.push(`default = ${scalarLit(f.default, valueType)}`)
  let label = ""
  const singular = f.type !== "array" && !(f.type === "object" && f.additionalProperties)
  const isMessageRef = !!f.$ref && !f.$ref.includes("/enums/")
  if (f.type === "array") label = "repeated "
  else if (!inOneof && singular) {
    if (syntax === "proto2") label = f.presence === "required" ? "required " : "optional "
    else if (syntax === "proto3") label = f.presence === "explicit" && !extension ? "optional " : ""
    else if (!extension) {
      const presence = presenceFeature(p.features, f, isMessageRef, oneofFeatures)
      if (presence) opts.push(presence)
    }
  }
  if (extension && syntax === "proto2" && f.type !== "array") label = "optional "
  const messageTyped =
    (singular && isMessageRef) ||
    (f.type === "array" && !!f.items && "$ref" in f.items && !f.items.$ref.includes("/enums/"))
  if (p.editions && messageTyped) {
    const encoding = messageEncodingFeature(p.features, f, oneofFeatures)
    if (encoding) opts.push(encoding)
  }
  opts.push(...resolvedFeatureOptions(f, syntax))
  const plan = planField(p.annotations, f, !groupMessage)
  opts.push(...optionAssignments(p.ctx.oracle, p.imports, plan.options, "field"))
  return { label, optText: opts.length ? ` [${opts.join(", ")}]` : "", plan }
}

/** A field declaration that is not a group: comment, then `label type name = number [options];`. */
export const printFieldLine = (p: FilePrinter, depth: number, name: string, f: ProtoApiField, head: FieldHead) => {
  p.out.comment(depth, fieldComment(p.ctx.tag, f, head.plan))
  let label = head.label
  let type: string
  if (f.type === "object" && f.additionalProperties) {
    type = `map<${scalarOf(f.propertyNames) ?? "string"}, ${p.typeOf(f.additionalProperties)}>`
    label = ""
  } else if (f.type === "array" && f.items) type = p.typeOf(f.items)
  else type = p.typeOf(f)
  p.out.emit(depth, `${label}${type} ${name} = ${f.number}${head.optText};`)
}
