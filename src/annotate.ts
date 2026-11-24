// Annotation layer (spec §3.8): comment tags, AIP prefixes and convention options lifted into JSON Schema keywords, with precedence built-in -> google.api -> buf.validate -> validate.rules -> openapiv2 -> comment tags / prefixes, and conflicts recorded. The conventions themselves live in conventions/.

import type { AnnotationSource } from "./types.ts"
import type { AnnotationInput, AnnotationResult, Candidate, CommentLine } from "./conventions/types.ts"
import { normalizeComment } from "./comments.ts"
import { optionKeyOf } from "./conventions/keys.ts"
import { liftGoogleApi } from "./conventions/google-api.ts"
import { liftValidation } from "./conventions/rules.ts"
import { liftOpenapiField, liftOpenapiOperation, liftOpenapiSchema } from "./conventions/openapiv2.ts"
import { liftTags, tagTable } from "./conventions/tags.ts"
import { liftPrefixes } from "./conventions/prefixes.ts"
import { mergeCandidates } from "./conventions/merge.ts"

/** The lines of a comment, none for an absent or empty one. */
const commentLines = (text: string | undefined): string[] =>
  (normalizeComment(text) ?? "").split("\n").filter((_, _i, a) => a.length > 1 || a[0] !== "")

export const annotate = (input: AnnotationInput): AnnotationResult => {
  const { kind, mode, shape } = input
  const options = { ...input.options }
  const result: AnnotationResult = {
    keywords: { "": {}, items: {}, propertyNames: {}, additionalProperties: {} },
    conflicts: [],
    invalidTags: [],
    invalidOptions: [],
    options,
    origins: [],
  }
  const candidates: Candidate[] = []
  const useOptions = mode !== "none"
  const useComments = mode === "all"
  const isField = kind === "field"

  let deprecated = false
  let reason: string | undefined
  const deprecate = (source: AnnotationSource, comment?: CommentLine) => {
    deprecated = true
    result.deprecationOrigin ??= comment ? { source, comment } : { source }
  }

  // built-in deprecation
  if (options.deprecated === true) {
    deprecate("option")
    delete options.deprecated
  }

  // --- options (fields only)
  if (useOptions && isField) {
    liftGoogleApi(options, shape, candidates)
    liftValidation(options, shape, candidates, result.invalidOptions)
    liftOpenapiField(options, shape, candidates)
  }
  if (useOptions && kind === "message") liftOpenapiSchema(options, candidates, input.fieldOf, result)
  // openapiv2_operation.deprecated on a method -> deprecation
  if (useOptions && kind === "method" && liftOpenapiOperation(options)) deprecate("openapiv2")
  for (const c of candidates) c.option ??= optionKeyOf(c, kind)
  for (const e of input.extra ?? []) candidates.push({ target: "", ...e })

  // --- comments
  const leadLines = commentLines(input.leading)
  const trailLines = commentLines(input.trailing)
  if (useComments) {
    const tags = {
      names: tagTable(input.tags).names,
      isField,
      shape,
      out: candidates,
      invalid: result.invalidTags,
      deprecate: (comment: CommentLine, value: string) => {
        deprecate("tag", comment)
        if (value) reason ??= value
      },
    }
    const lead = liftTags(leadLines, false, tags)
    const lines = [...lead, ...liftTags(trailLines, true, tags)]
    liftPrefixes(lines, lead.length, {
      isField,
      options,
      out: candidates,
      deprecate: (comment, value) => {
        deprecate("prefix", comment)
        if (value) reason = value
      },
    })
    result.description = normalizeComment(lines.join("\n"))
  } else {
    result.description = normalizeComment([...leadLines, ...trailLines].join("\n"))
  }
  if (deprecated) result.deprecation = reason ? { reason } : {}

  // --- precedence: sources in the order of spec §3.8, first wins
  mergeCandidates(candidates, shape, result)
  return result
}
