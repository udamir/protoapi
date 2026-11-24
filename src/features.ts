// Editions feature resolution (design §6.2 "Feature resolution", rule D in §3.5).
//
// A feature's value on an element is the nearest explicitly set value walking field -> oneof -> message ->
// enclosing messages -> file, else the edition default. Edition defaults come from the `edition_defaults` of the
// `google.protobuf.FeatureSet` fields in the descriptor.proto the build uses: a user-supplied descriptor.proto wins
// (design §5.2), the bundled one (generated into src/bundle/features.ts) fills the features it does not define.
// proto2 and proto3 files use the defaults of EDITION_PROTO2 and EDITION_PROTO3.

import type { BuildIssue, KnownProtoSyntax, Location, ProtoSyntax } from "./types.ts"
import type { OptionTree } from "./model.ts"
import { isPlainObject } from "./values.ts"

/** Resolved values of the `google.protobuf.FeatureSet` fields (enum value names). */
export interface ResolvedFeatures {
  field_presence: string
  enum_type: string
  repeated_field_encoding: string
  utf8_validation: string
  message_encoding: string
  json_format: string
  enforce_naming_style: string
  default_symbol_visibility: string
  enforce_proto_limits: string
  [feature: string]: string | undefined
}

/** The `FeatureSetDefaults` inputs read from a descriptor.proto. */
export interface FeatureDefaultsSource {
  /** `google.protobuf.Edition`: value name -> number */
  editions: Record<string, number>
  /** `FeatureSet` field -> its `edition_defaults` as [edition name, value], in declaration order */
  defaults: Record<string, [string, string][]>
}

/** Editions this version supports, by `Edition` enum name. */
export const KNOWN_EDITIONS: Readonly<Record<string, KnownProtoSyntax>> = {
  EDITION_PROTO2: "proto2",
  EDITION_PROTO3: "proto3",
  EDITION_2023: "2023",
  EDITION_2024: "2024",
  EDITION_2026: "2026",
}

const EDITION_OF: Record<KnownProtoSyntax, string> = {
  proto2: "EDITION_PROTO2",
  proto3: "EDITION_PROTO3",
  "2023": "EDITION_2023",
  "2024": "EDITION_2024",
  "2026": "EDITION_2026",
}

/** Numbers of the `Edition` values (descriptor.proto v36), used when a descriptor.proto lacks a value. */
export const EDITION_NUMBERS: Readonly<Record<string, number>> = {
  EDITION_UNKNOWN: 0,
  EDITION_LEGACY: 900,
  EDITION_PROTO2: 998,
  EDITION_PROTO3: 999,
  EDITION_2023: 1000,
  EDITION_2024: 1001,
  EDITION_2026: 1002,
  EDITION_1_TEST_ONLY: 1,
  EDITION_2_TEST_ONLY: 2,
  EDITION_99997_TEST_ONLY: 99997,
  EDITION_99998_TEST_ONLY: 99998,
  EDITION_99999_TEST_ONLY: 99999,
  EDITION_UNSTABLE: 9999,
  EDITION_MAX: 2147483647,
}

/** The newest edition this version supports; editions it does not know resolve features with its defaults. */
export const NEWEST_EDITION: KnownProtoSyntax = "2026"

export const isKnownSyntax = (syntax: ProtoSyntax): syntax is KnownProtoSyntax => syntax in EDITION_OF

export const isEditions = (syntax: ProtoSyntax) => syntax !== "proto2" && syntax !== "proto3"

/** The `Edition` number of a syntax (proto2 998 < proto3 999 < 2023 1000 < 2024 1001 < 2026 1002); editions this
 *  version does not know rank as the newest known edition, like their feature defaults. */
export const editionNumber = (syntax: ProtoSyntax): number =>
  EDITION_NUMBERS[EDITION_OF[isKnownSyntax(syntax) ? syntax : NEWEST_EDITION]]

/** The `Edition` enum name of a syntax (`EDITION_2024`), as above. */
export const editionName = (syntax: ProtoSyntax): string => EDITION_OF[isKnownSyntax(syntax) ? syntax : NEWEST_EDITION]

/** The `unsupported` issue of an edition this version does not know (both producers, decision D-C). */
export const unsupportedEdition = (
  what: string,
  file: string,
  filePointer: string,
  location: Location | undefined,
): BuildIssue => ({
  code: "unsupported",
  message: `${what} is not supported by this version of protoapi; features resolve with the edition ${NEWEST_EDITION} defaults`,
  file,
  location,
  pointer: `#/files/${filePointer}/syntax`,
})

/** Read the defaults from typed `FeatureSet` field options (`edition_defaults: [{ edition, value }]`). */
export const featureDefaultsSource = (
  fields: { name: string; editionDefaults: unknown }[],
  editions: { name: string; number: number }[],
): FeatureDefaultsSource => {
  const out: FeatureDefaultsSource = { editions: {}, defaults: {} }
  for (const e of editions) out.editions[e.name] = e.number
  for (const f of fields) {
    if (!Array.isArray(f.editionDefaults)) continue
    const entries: [string, string][] = []
    for (const d of f.editionDefaults)
      if (isPlainObject(d) && typeof d.edition === "string" && typeof d.value === "string")
        entries.push([d.edition, d.value])
    if (entries.length) out.defaults[f.name] = entries
  }
  return out
}

/** `over` wins per feature and per edition name; `base` fills the rest. */
export const mergeFeatureDefaults = (
  base: FeatureDefaultsSource,
  over: FeatureDefaultsSource,
): FeatureDefaultsSource => ({
  editions: { ...base.editions, ...over.editions },
  defaults: { ...base.defaults, ...over.defaults },
})

/** Edition defaults by syntax, computed once per syntax. */
export class FeatureDefaults {
  private readonly cache = new Map<string, ResolvedFeatures>()

  readonly source: FeatureDefaultsSource

  constructor(source: FeatureDefaultsSource) {
    this.source = source
  }

  private number(edition: string): number | undefined {
    return this.source.editions[edition] ?? EDITION_NUMBERS[edition]
  }

  /** Defaults for a file's syntax; an edition this version does not know gets the newest known edition's defaults. */
  forSyntax(syntax: ProtoSyntax): ResolvedFeatures {
    const key: KnownProtoSyntax = isKnownSyntax(syntax) ? syntax : NEWEST_EDITION
    const cached = this.cache.get(key)
    if (cached) return cached
    const target = this.number(EDITION_OF[key]) ?? 0
    const out: Record<string, string> = {}
    for (const [feature, entries] of Object.entries(this.source.defaults)) {
      let best: number | undefined
      for (const [edition, value] of entries) {
        const n = this.number(edition)
        if (n === undefined || n > target || (best !== undefined && n < best)) continue
        best = n
        out[feature] = value
      }
    }
    const resolved = out as unknown as ResolvedFeatures
    this.cache.set(key, resolved)
    return resolved
  }
}

/** The `features` sub-tree of an element's typed options, if any. */
export const featuresOf = (options: OptionTree | undefined): Record<string, unknown> | undefined => {
  const f = options?.features
  return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : undefined
}

/** Resolve features along a chain of option trees ordered from the outermost (file) to the innermost element. */
export const resolveFeatures = (
  base: ResolvedFeatures,
  syntax: ProtoSyntax,
  chain: (OptionTree | undefined)[],
): ResolvedFeatures => {
  if (!isEditions(syntax)) return base
  const out: Record<string, unknown> = { ...base }
  for (const options of chain) {
    const f = featuresOf(options)
    if (!f) continue
    for (const [k, v] of Object.entries(f)) if (k in base && typeof v === "string") out[k] = v
  }
  return out as unknown as ResolvedFeatures
}
