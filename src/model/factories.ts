// Factories of model elements used by both front ends: one key order for every message, enum and file, whichever
// front end creates it.

import type { ProtoSyntax } from "../types.ts"
import type { Locs, MEnum, MFile, MImport, MMessage, MOptionHolder, PendingIssue } from "./types.ts"

export const newHolder = (): MOptionHolder => ({ raw: [], options: {}, optionLocs: {} })

/** Record an issue on a model element, to be emitted by the lowering. */
export const addPending = (holder: { pending?: PendingIssue[] }, issue: PendingIssue) => {
  if (!holder.pending) holder.pending = []
  holder.pending.push(issue)
}

/** A message without members (the front end adds them). `tail` holds the keys after the ranges, in order: `mapEntry` (descriptor producer only), `visibility`, `comments`, `locs`. */
export const newMessage = (
  holder: MOptionHolder,
  name: string,
  fqn: string,
  file: MFile,
  tail: Pick<MMessage, "mapEntry" | "visibility" | "comments" | "locs">,
): MMessage => ({
  ...holder,
  name,
  fqn,
  fields: [],
  oneofs: [],
  nested: [],
  enums: [],
  extensions: [],
  reservedRanges: [],
  reservedNames: [],
  reservedLocs: { ranges: [], names: [] },
  extensionRanges: [],
  ...tail,
  file,
})

/** An enum without values (the front end adds them). */
export const newEnum = (
  holder: MOptionHolder,
  name: string,
  fqn: string,
  file: MFile,
  tail: Pick<MEnum, "visibility" | "comments" | "locs">,
): MEnum => ({
  ...holder,
  name,
  fqn,
  values: [],
  reservedRanges: [],
  reservedNames: [],
  reservedLocs: { ranges: [], names: [] },
  ...tail,
  file,
})

/** A file without declarations (the front end adds them). `origin` is `{ bundled }` (text producer) or `{ isImport }` (descriptor producer). */
export const newFile = (
  holder: MOptionHolder,
  path: string,
  syntax: ProtoSyntax,
  pkg: string,
  imports: MImport[],
  locs: Locs,
  origin: Pick<MFile, "bundled"> | Pick<MFile, "isImport">,
): MFile => ({
  ...holder,
  path,
  syntax,
  package: pkg,
  imports,
  messages: [],
  enums: [],
  extensions: [],
  services: [],
  locs,
  ...origin,
  parsed: true,
})
