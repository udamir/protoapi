// google.api conventions: `field_behavior` values and `field_info.format`, lifted into keywords and read back by the printer from the same tables.

import { isPlainObject } from "../common/objects.ts"
import { FIELD_BEHAVIOR, FIELD_INFO, putRest } from "./keys.ts"
import { type Candidate, type FieldShape, type Target, slotOf } from "./types.ts"

/** field_behavior values that lift, with the keyword each sets to `true` (`OPTIONAL` sets `required: false` and stays listed). */
export const FIELD_BEHAVIOR_KEYWORDS = new Map<unknown, string>([
  ["REQUIRED", "required"],
  ["OUTPUT_ONLY", "readOnly"],
  ["INPUT_ONLY", "writeOnly"],
  ["IMMUTABLE", "immutable"],
])

/** FIELD_BEHAVIOR_KEYWORDS inverted: keyword -> the field_behavior value that prints it. */
export const BEHAVIOR_OF_KEYWORD: Record<string, string> = Object.fromEntries(
  [...FIELD_BEHAVIOR_KEYWORDS].map(([value, keyword]) => [keyword, value as string]),
)

/** field_info.format values that lift, with the JSON Schema format each means. */
export const FIELD_INFO_FORMATS: Record<string, string> = {
  UUID4: "uuid",
  IPV4: "ipv4",
  IPV6: "ipv6",
  IPV4_OR_IPV6: "ip",
}

/** FIELD_INFO_FORMATS inverted: format keyword value -> field_info.format value. */
export const FIELD_INFO_FORMAT_OF: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_INFO_FORMATS).map(([k, v]) => [v, k]),
)

/** Lift google.api.field_behavior and google.api.field_info of a field into `out`; the rest stays under options. */
export const liftGoogleApi = (options: Record<string, unknown>, shape: FieldShape | undefined, out: Candidate[]) => {
  const fb = options[FIELD_BEHAVIOR]
  if (Array.isArray(fb)) {
    const rest: unknown[] = []
    for (const b of fb) {
      const keyword = FIELD_BEHAVIOR_KEYWORDS.get(b)
      if (keyword) out.push({ target: "", keyword, value: true, source: "google.api" })
      else {
        if (b === "OPTIONAL") out.push({ target: "", keyword: "required", value: false, source: "google.api" })
        rest.push(b)
      }
    }
    putRest(options, FIELD_BEHAVIOR, rest)
  }
  // field_info.format describes string values only; on other types it stays under options
  const fi = options[FIELD_INFO]
  const fiTarget: Target = shape?.repeated ? "items" : ""
  if (
    isPlainObject(fi) &&
    typeof fi.format === "string" &&
    Object.hasOwn(FIELD_INFO_FORMATS, fi.format) &&
    !shape?.map &&
    slotOf(shape, fiTarget)?.scalar === "string"
  ) {
    out.push({
      target: fiTarget,
      keyword: "format",
      value: FIELD_INFO_FORMATS[fi.format],
      source: "google.api",
    })
    const r = { ...fi }
    delete r.format
    putRest(options, FIELD_INFO, r)
  }
}
