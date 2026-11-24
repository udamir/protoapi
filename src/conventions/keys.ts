// The option keys of the convention options (google.api, protovalidate, PGV, grpc-gateway openapiv2), their option message types, and the helpers that read lifted values and write the unlifted rest of an option back.

import type { Candidate, ElementKind } from "./types.ts"

/** The grpc-gateway openapiv2 package and its option names. */
export const OPENAPIV2_PACKAGE = "grpc.gateway.protoc_gen_openapiv2.options."
export const OPENAPIV2_FIELD = `${OPENAPIV2_PACKAGE}openapiv2_field`
export const OPENAPIV2_SCHEMA = `${OPENAPIV2_PACKAGE}openapiv2_schema`
export const OPENAPIV2_OPERATION = `${OPENAPIV2_PACKAGE}openapiv2_operation`

/** protovalidate field rules */
export const BUF_VALIDATE_FIELD = "buf.validate.field"
/** protoc-gen-validate (PGV) field rules */
export const PGV_RULES = "validate.rules"

export const FIELD_BEHAVIOR = "google.api.field_behavior"
export const FIELD_INFO = "google.api.field_info"
export const HTTP_RULE = "google.api.http"

/** Option message types of the convention options the printer fills. */
export const OPTION_TYPES: Record<string, string> = {
  [BUF_VALIDATE_FIELD]: "buf.validate.FieldRules",
  [PGV_RULES]: "validate.FieldRules",
  [OPENAPIV2_FIELD]: `${OPENAPIV2_PACKAGE}JSONSchema`,
  [OPENAPIV2_SCHEMA]: `${OPENAPIV2_PACKAGE}Schema`,
  [FIELD_INFO]: "google.api.FieldInfo",
}

/** The option key an option-sourced candidate was lifted from. */
export const optionKeyOf = (c: Candidate, kind: ElementKind): string | undefined => {
  switch (c.source) {
    case "google.api":
      return c.keyword === "format" ? FIELD_INFO : FIELD_BEHAVIOR
    case "buf.validate":
      return BUF_VALIDATE_FIELD
    case "validate.rules":
      return PGV_RULES
    case "openapiv2":
      return kind === "message" ? OPENAPIV2_SCHEMA : OPENAPIV2_FIELD
    default:
      return undefined
  }
}

/** What is left of option `key` after lifting: kept when it has entries, else the key is removed. */
export const putRest = (options: Record<string, unknown>, key: string, rest: object | undefined) => {
  if (rest !== undefined && Object.keys(rest).length) options[key] = rest
  else delete options[key]
}

/** A count or length option value as a number (64-bit values are decimal strings). */
export const asNumber = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number))
