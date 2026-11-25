// Editions: the `google.protobuf.Edition` names and numbers, and the syntax each edition this version knows maps to
// (`EDITION_PROTO3` <-> "proto3", `EDITION_2024` <-> "2024").

import type { KnownProtoSyntax, ProtoSyntax } from "../types.ts"
import { bundledFeatureDefaults } from "../bundle/features.ts"

/** Editions this version supports, by `Edition` enum name. Look names up with `knownSyntaxOfEdition` (own properties only: `constructor` is not an edition). */
const KNOWN_EDITIONS: Readonly<Record<string, KnownProtoSyntax>> = {
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

/** Numbers of the `Edition` values (of the bundled descriptor.proto), used when a descriptor.proto lacks a value. */
export const EDITION_NUMBERS: Readonly<Record<string, number>> = bundledFeatureDefaults.editions

/** The syntax of an edition this version supports, by `Edition` enum name (`EDITION_2024` -> "2024"); undefined for any other name. */
export const knownSyntaxOfEdition = (name: string): KnownProtoSyntax | undefined =>
  Object.hasOwn(KNOWN_EDITIONS, name) ? KNOWN_EDITIONS[name] : undefined

/** The number of an `Edition` enum name of the bundled descriptor.proto (`EDITION_2024` -> 1001); undefined for any other name. */
export const editionNumberOfName = (name: string): number | undefined =>
  Object.hasOwn(EDITION_NUMBERS, name) ? EDITION_NUMBERS[name] : undefined

const EDITION_BY_NUMBER: Record<number, string> = Object.fromEntries(
  Object.entries(EDITION_NUMBERS).map(([name, n]) => [n, name]),
)

/** The newest edition this version supports; editions it does not know resolve features with its defaults. */
export const NEWEST_EDITION: KnownProtoSyntax = "2026"

export const isKnownSyntax = (syntax: ProtoSyntax): syntax is KnownProtoSyntax => Object.hasOwn(EDITION_OF, syntax)

export const isEditions = (syntax: ProtoSyntax) => syntax !== "proto2" && syntax !== "proto3"

/** The `Edition` enum name of a syntax (`EDITION_2024`); editions this version does not know get the newest known edition's name. */
export const editionName = (syntax: ProtoSyntax): string => EDITION_OF[isKnownSyntax(syntax) ? syntax : NEWEST_EDITION]

/** The `Edition` number of a syntax (proto2 998 < proto3 999 < 2023 1000 < 2024 1001 < 2026 1002); editions this
 *  version does not know rank as the newest known edition, like their feature defaults. */
export const editionNumber = (syntax: ProtoSyntax): number => EDITION_NUMBERS[editionName(syntax)]

/** The `Edition` enum name of a known syntax (`2024` -> `EDITION_2024`), undefined for any other syntax. */
export const knownEditionName = (syntax: ProtoSyntax): string | undefined =>
  isKnownSyntax(syntax) ? EDITION_OF[syntax] : undefined

/** The `Edition` enum name of an edition number (`1001` -> `EDITION_2024`); a number without a name as its decimal string. */
export const editionNameOfNumber = (n: number): string =>
  Object.hasOwn(EDITION_BY_NUMBER, n) ? EDITION_BY_NUMBER[n] : String(n)
