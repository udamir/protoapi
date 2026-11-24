// Naming checks: the styles of edition 2024 `enforce_naming_style` (STYLE2024 / STYLE2026, as buf checks them) and protoc's key of an enum value for its uniqueness check.

import type { Location } from "../types.ts"
import type { MFile } from "../model.ts"
import type { ResolvedFeatures } from "../features.ts"
import type { ValidateContext } from "./context.ts"

// ---- naming styles (edition 2024 enforce_naming_style STYLE2024 / STYLE2026, as buf checks them) -------------------
const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/
const PASCAL = /^[A-Z][A-Za-z0-9]*$/
const SCREAMING = /^[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*$/

/** The style each kind of name must follow, as issue messages name it. */
const NAMING_STYLES = {
  package: { style: "lower_snake_case", ok: (name: string) => name.split(".").every((p) => SNAKE.test(p)) },
  message: { style: "PascalCase", ok: (name: string) => PASCAL.test(name) },
  field: { style: "snake_case", ok: (name: string) => SNAKE.test(name) },
  oneof: { style: "snake_case", ok: (name: string) => SNAKE.test(name) },
  extension: { style: "snake_case", ok: (name: string) => SNAKE.test(name) },
  enum: { style: "PascalCase", ok: (name: string) => PASCAL.test(name) },
  "enum value": { style: "SCREAMING_SNAKE_CASE", ok: (name: string) => SCREAMING.test(name) },
  service: { style: "PascalCase", ok: (name: string) => PASCAL.test(name) },
  method: { style: "PascalCase", ok: (name: string) => PASCAL.test(name) },
}

export type NamedKind = keyof typeof NAMING_STYLES

/** Naming styles are enforced (`enforce_naming_style` STYLE2024 or STYLE2026). */
export const isStyled = (features: ResolvedFeatures): boolean => {
  const s = features.enforce_naming_style
  return s === "STYLE2024" || s === "STYLE2026"
}

/** An `invalid-definition` when `name` does not follow the style of its kind. */
export const checkName = (
  cx: ValidateContext,
  kind: NamedKind,
  name: string,
  file: MFile,
  pointer: string,
  loc: Location | undefined,
) => {
  const { style, ok } = NAMING_STYLES[kind]
  if (!ok(name)) cx.issue("invalid-definition", `${kind} name ${name} should be ${style}`, file, pointer, loc)
}

// ---- enum value keys ---------------------------------------------------------------------------------------------

/** protoc's `PrefixRemover::MaybeRemove`: `value` without the enum name prefix (case and underscores ignored). */
const removePrefix = (prefix: string, value: string): string => {
  let i = 0
  let j = 0
  for (; i < value.length && j < prefix.length; i++) {
    if (value[i] === "_") continue
    if (value[i].toLowerCase() !== prefix[j++]) return value
  }
  if (j < prefix.length) return value
  while (i < value.length && value[i] === "_") i++
  return i === value.length ? value : value.slice(i)
}

/** protoc's `EnumValueToPascalCase` of the value without its prefix (`CheckEnumValueUniqueness`). */
export const enumValueKey = (enumName: string, value: string): string => {
  const stripped = removePrefix(enumName.replace(/_/g, "").toLowerCase(), value)
  let out = ""
  let upper = true
  for (const ch of stripped) {
    if (ch === "_") upper = true
    else {
      out += upper ? ch.toUpperCase() : ch.toLowerCase()
      upper = false
    }
  }
  return out
}
