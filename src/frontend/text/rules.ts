// The syntactic rules of a syntax or edition, checked by the text front end while the AST is at hand (validation
// decision D-E): labels, groups, map keys, reserved names, visibility keywords, import flags, oneofs, extensions.

import type { Location } from "../../types.ts"
import type { MField, MImport } from "../../model/index.ts"
import type { Keyword, Span } from "../../parser/index.ts"
import { EDITION_NUMBERS, editionNumber, isEditions } from "../../common/editions.ts"
import { syntaxName } from "../../common/names.ts"
import { type Ctx, report } from "./context.ts"

/**
 * The label rules of the file's syntax (D-E): proto2 fields outside a oneof need a label, proto3 has no `required`,
 * editions have neither `optional` nor `required` (features.field_presence replaces them), extensions are never
 * `required`.
 */
export const checkLabel = (
  ctx: Ctx,
  n: Span,
  label: Keyword | undefined,
  what: string,
  pointer: string,
  extension: boolean,
) => {
  const text: string | undefined = label?.text
  if (extension && text === "required") {
    report(ctx, "invalid-definition", `extension ${what} cannot be required`, label, pointer)
    return
  }
  if (ctx.syntax === "proto2") {
    if (!label)
      report(
        ctx,
        "invalid-definition",
        `field ${what} needs a label (optional, required or repeated) in proto2`,
        n,
        pointer,
      )
  } else if (ctx.syntax === "proto3") {
    if (text === "required")
      report(ctx, "invalid-definition", `required fields are not allowed in proto3 (${what})`, label, pointer)
  } else if (text === "optional" || text === "required") {
    report(
      ctx,
      "invalid-definition",
      `the label "${text}" is not allowed in editions (${what}); use features.field_presence instead`,
      label,
      pointer,
    )
  }
}

/** Groups exist in proto2 only; a group outside a oneof follows the label rules. */
export const checkGroup = (
  ctx: Ctx,
  n: Span,
  keyword: Keyword,
  label: Keyword | undefined,
  name: string,
  pointer: string,
  inOneof: boolean,
  extension: boolean,
) => {
  if (ctx.syntax !== "proto2")
    report(ctx, "invalid-definition", `group syntax is not supported in ${syntaxName(ctx.syntax)}`, keyword, pointer)
  else if (!inOneof) checkLabel(ctx, n, label, name, pointer, extension)
}

const MAP_KEY_INVALID = new Set(["float", "double", "bytes"])

/** The map key must be an integral, bool or string scalar (D-E: a message key used to become `string`). */
export const checkMapKey = (ctx: Ctx, key: string, scalar: boolean, keyType: Span, pointer: string) => {
  if (!scalar || MAP_KEY_INVALID.has(key))
    report(
      ctx,
      "unresolved-type",
      `map key type ${key} is not allowed: a map key must be an integer, bool or string type`,
      keyType,
      pointer,
    )
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reserved names: editions write them as identifiers, proto2 / proto3 as string literals, and a quoted name must be
 * an identifier (D-E; buf: "cannot use string literals in reserved range in editions mode", "reserved message field
 * name is not a valid identifier").
 */
export const checkReservedName = (
  ctx: Ctx,
  name: string,
  quoted: boolean,
  at: Location | undefined,
  pointer: string,
) => {
  const editions = isEditions(ctx.syntax)
  if (quoted === editions)
    report(
      ctx,
      "invalid-definition",
      editions
        ? `reserved names are identifiers in editions, not string literals ("${name}")`
        : `reserved names are string literals in ${ctx.syntax} (${name})`,
      at,
      pointer,
    )
  else if (!IDENT.test(name))
    report(ctx, "invalid-definition", `reserved name "${name}" is not a valid identifier`, at, pointer)
}

/** `export` / `local` exist from edition 2024 on. */
export const checkVisibility = (ctx: Ctx, keyword: Keyword, pointer: string) => {
  if (editionNumber(ctx.syntax) < EDITION_NUMBERS.EDITION_2024)
    report(
      ctx,
      "invalid-definition",
      `\`${keyword.text}\` is not supported in ${syntaxName(ctx.syntax)}`,
      keyword,
      pointer,
    )
}

/** `import option` exists from edition 2024 on and comes after the other imports; `import weak` ends with edition 2024. */
export const checkImport = (ctx: Ctx, st: Span, flag: MImport["flag"], afterOptionImport: boolean, pointer: string) => {
  const edition = editionNumber(ctx.syntax)
  if (flag === "option" && edition < EDITION_NUMBERS.EDITION_2024)
    report(ctx, "invalid-definition", `\`import option\` is not supported in ${syntaxName(ctx.syntax)}`, st, pointer)
  else if (flag === "weak" && edition >= EDITION_NUMBERS.EDITION_2024)
    report(ctx, "invalid-definition", `\`import weak\` is not supported in ${syntaxName(ctx.syntax)}`, st, pointer)
  if (flag !== "option" && afterOptionImport)
    report(ctx, "invalid-definition", "import after `import option`: option imports must come last", st, pointer)
}

/** A oneof needs at least one member. */
export const checkOneofMembers = (ctx: Ctx, st: Span, name: string, members: number, pointer: string) => {
  if (!members) report(ctx, "invalid-definition", `oneof ${name} must have at least one member`, st, pointer)
}

/** proto3 has no extension ranges. */
export const checkExtensionRanges = (ctx: Ctx, st: Span, pointer: string) => {
  if (ctx.syntax === "proto3")
    report(ctx, "invalid-definition", "extension ranges are not allowed in proto3", st, pointer)
}

/** Extensions have no `json_name`. */
export const checkExtensionJsonName = (ctx: Ctx, field: MField, pointer: string) => {
  if (field.jsonName !== undefined)
    report(ctx, "invalid-option", `json_name is not allowed on extension ${field.name}`, field.locs.jsonName, pointer)
}
