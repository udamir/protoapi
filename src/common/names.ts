// Names: fully qualified names and their scopes, the JSON Pointers of document elements, and the names protoc derives
// (map entry messages) or writes in messages (`proto3`, `edition 2024`).

import type { ProtoSyntax } from "../types.ts"
import { ptr } from "../paths.ts"
import { isEditions } from "./editions.ts"

/** `name` in `scope` (`a.b` + `M` -> `a.b.M`); in the root scope (`""`) the name itself. */
export const qualify = (scope: string, name: string): string => (scope ? `${scope}.${name}` : name)

/**
 * The scope enclosing `fqn` (`a.b.M` -> `a.b`). Option names are looked up from the scope buf uses for each element:
 * the enclosing scope of a message for message, oneof and extension-range options, the message for field options,
 * the enum's scope for enum and enum value options, the service for service and method options, the package for file
 * options.
 */
export const parentScope = (fqn: string): string => fqn.slice(0, Math.max(0, fqn.lastIndexOf(".")))

/** The last segment of a qualified name (`a.b.M` -> `M`). */
export const lastSegment = (fqn: string) => fqn.slice(fqn.lastIndexOf(".") + 1)

/** The fqn of an extension declared in `scope`: the one the symbol table gave it, else its name in `scope`. */
export const extensionFqn = (x: { fqn?: string; name: string }, scope: string): string =>
  x.fqn ?? qualify(scope, x.name)

// ---- JSON Pointers of document elements ------------------------------------------------------------------------------

export const filePointer = (path: string) => `#/files/${ptr(path)}`
export const messagePointer = (fqn: string) => `#/components/messages/${ptr(fqn)}`
export const enumPointer = (fqn: string) => `#/components/enums/${ptr(fqn)}`
export const extensionPointer = (fqn: string) => `#/components/extensions/${ptr(fqn)}`
export const servicePointer = (fqn: string) => `#/services/${ptr(fqn)}`

// ---- derived names ---------------------------------------------------------------------------------------------------

/** A syntax as issue messages name it: `proto2`, `proto3`, `edition 2024`. */
export const syntaxName = (syntax: ProtoSyntax) => (isEditions(syntax) ? `edition ${syntax}` : syntax)

/** protoc's map entry message name: `foo_bar` -> `FooBarEntry`. */
export const mapEntryName = (field: string): string => {
  let out = ""
  let upper = true
  for (const ch of field) {
    if (ch === "_") upper = true
    else {
      out += upper ? ch.toUpperCase() : ch
      upper = false
    }
  }
  return `${out}Entry`
}
