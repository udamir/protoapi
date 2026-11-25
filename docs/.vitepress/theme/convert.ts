/**
 * Every conversion the documentation shows, between `.proto` files, FileDescriptorSets and ProtoApi documents.
 * Shared by the online demo (browser) and the examples data loader (build time), so both produce the same output.
 */
import { dump, load } from "js-yaml"

import { buildFromDescriptorSet, buildFromProto, printProto } from "../../../src/index.ts"
import type {
  BuildIssue,
  BuildOptions,
  BuildResult,
  FileDescriptorSetJson,
  ProtoApiDocument,
  SourceMap,
} from "../../../src/index.ts"

export type SourceKind = "proto" | "descriptor" | "protoapi"
export type TargetKind = "protoapi" | "proto" | "sourcemap"
export type TextFormat = "yaml" | "json"
export type Language = "proto" | "json" | "yaml"
export type ImportsMode = NonNullable<BuildOptions["imports"]>
export type AnnotationsMode = NonNullable<BuildOptions["annotations"]>

export const SOURCES: { id: SourceKind; label: string; language: Language }[] = [
  { id: "proto", label: ".proto files", language: "proto" },
  { id: "descriptor", label: "FileDescriptorSet", language: "json" },
  { id: "protoapi", label: "ProtoApi", language: "yaml" },
]

export const TARGETS: { id: TargetKind; label: string }[] = [
  { id: "protoapi", label: "ProtoApi" },
  { id: "proto", label: ".proto files" },
  { id: "sourcemap", label: "Source map" },
]

/** The build options the demo exposes */
export interface DemoOptions {
  imports: ImportsMode
  annotations: AnnotationsMode
  /** entry files; undefined means every file */
  entry?: string[]
}

export const DEFAULT_OPTIONS: DemoOptions = { imports: "user", annotations: "all" }

export interface Conversion {
  /** output name (a file path for `.proto` output, else the target) -> text */
  outputs: Record<string, string>
  language: Language
  /** the protoapi calls that perform the conversion */
  code: string
  /** what the conversion cannot carry over */
  notes: string[]
  issues: BuildIssue[]
  /** the source map of the build, when the conversion built a document */
  sourceMap?: SourceMap
}

export const serialize = (value: unknown, format: TextFormat): string =>
  format === "yaml" ? dump(value, { noRefs: true, lineWidth: 120 }) : `${JSON.stringify(value, null, 2)}\n`

/** Parses a ProtoApi document written as YAML or JSON (JSON is valid YAML) */
export const parseDocument = (text: string): ProtoApiDocument => {
  const doc = load(text)
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Expected a ProtoApi document (a YAML or JSON object)")
  }
  return doc as ProtoApiDocument
}

/** Accepts a FileDescriptorSet or a buf image in ProtoJSON (`buf build -o image.json`) */
export const parseDescriptorSet = (text: string): FileDescriptorSetJson => {
  const set = JSON.parse(text) as Partial<FileDescriptorSetJson>
  if (!set || typeof set !== "object" || !Array.isArray(set.file)) {
    throw new Error('Expected a FileDescriptorSet in ProtoJSON: { "file": [ … ] } (buf build -o image.json)')
  }
  return set as FileDescriptorSetJson
}

/** The non-default build options, as passed to the builders */
export const buildOptions = (options: DemoOptions): BuildOptions => {
  const result: BuildOptions = {}
  if (options.entry) result.entry = options.entry
  if (options.imports !== "user") result.imports = options.imports
  if (options.annotations !== "all") result.annotations = options.annotations
  return result
}

/** `{ imports: "all" }`, or nothing for the defaults */
export const optionsCode = (options: object): string => {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined)
  return entries.length ? `, { ${entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(", ")} }` : ""
}

/** The print options that reproduce a build with these options */
const printOptions = (options: BuildOptions) =>
  options.annotations && options.annotations !== "all" ? { tags: false } : {}

/** 1-based `line:column`, as editors show it */
const at = (position: { line: number; column: number }): string => `${position.line + 1}:${position.column + 1}`

/** The source map as YAML: pointer -> `file line:column-line:column` (1-based, end exclusive) */
export const formatSourceMap = (sourceMap: SourceMap, files?: string[]): string => {
  const lines: string[] = []
  for (const [pointer, location] of Object.entries(sourceMap)) {
    if (files && !files.includes(location.file)) continue
    lines.push(`"${pointer}": ${location.file} ${at(location.start)}-${at(location.end)}`)
  }
  return lines.length ? `${lines.join("\n")}\n` : "# no entries\n"
}

export const formatIssue = (issue: BuildIssue): string => {
  const where = issue.location ? `${issue.location.file}:${at(issue.location.start)}` : (issue.file ?? "")
  return `${issue.code}${where ? ` ${where}` : ""} ${issue.message}`
}

const documentOutput = (
  result: BuildResult,
  target: TargetKind,
  format: TextFormat,
  options: BuildOptions,
  build: string,
  userFiles?: string[],
): Conversion => {
  if (target === "protoapi") {
    return {
      outputs: { protoapi: serialize(result.document, format) },
      language: format,
      code: `const { document, sourceMap, issues } = ${build}`,
      notes: [],
      issues: result.issues,
      sourceMap: result.sourceMap,
    }
  }
  if (target === "sourcemap") {
    return {
      outputs: { sourcemap: formatSourceMap(result.sourceMap, userFiles) },
      language: "yaml",
      code: `const { sourceMap } = ${build}`,
      notes: [
        "Pointer → file line:column-line:column (1-based here; the source map itself is zero-based, end exclusive).",
        ...(userFiles ? ["Entries of bundled files are left out."] : []),
      ],
      issues: result.issues,
      sourceMap: result.sourceMap,
    }
  }
  return {
    outputs: printProto(result.document, printOptions(options)),
    language: "proto",
    code: `const files = printProto(${build}.document${optionsCode(printOptions(options))})`,
    notes: ["Files marked bundled are not printed: they resolve from the bundle when the files are built again."],
    issues: result.issues,
    sourceMap: result.sourceMap,
  }
}

export interface ConvertInput {
  source: SourceKind
  /** `.proto` files (path -> text) for source "proto", else one text under any key */
  files: Record<string, string>
  target: TargetKind
  format: TextFormat
  options: DemoOptions
}

export const convert = ({ source, files, target, format, options }: ConvertInput): Conversion => {
  const build = buildOptions(options)
  switch (source) {
    case "proto": {
      const result = buildFromProto(files, build)
      return documentOutput(
        result,
        target,
        format,
        build,
        `buildFromProto(files${optionsCode(build)})`,
        Object.keys(files),
      )
    }

    case "descriptor": {
      const set = parseDescriptorSet(Object.values(files)[0] ?? "")
      const result = buildFromDescriptorSet(set, build)
      const names = set.file.map((file) => String(file.name ?? ""))
      return documentOutput(result, target, format, build, `buildFromDescriptorSet(image${optionsCode(build)})`, names)
    }

    case "protoapi": {
      const doc = parseDocument(Object.values(files)[0] ?? "")
      if (target === "protoapi") {
        // a round trip through the printer normalizes the document
        const result = buildFromProto(printProto(doc), build)
        return {
          ...documentOutput(result, "protoapi", format, build, "buildFromProto(printProto(document))"),
          notes: ["The document is normalized by printing it and building the printed files again."],
        }
      }
      if (target === "sourcemap") {
        const result = buildFromProto(printProto(doc), build)
        return {
          ...documentOutput(result, "sourcemap", format, build, "buildFromProto(printProto(document))"),
          notes: ["A document has no source of its own: the source map locates the nodes in the printed files."],
        }
      }
      return {
        outputs: printProto(doc),
        language: "proto",
        code: "const files = printProto(document)",
        notes: [],
        issues: [],
      }
    }
  }
}

/** Equality of two documents without `x-annotation-conflicts`, which a round trip cannot keep */
export const withoutConflicts = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, item) => (key === "x-annotation-conflicts" ? undefined : item)))

/** Encodes the demo state into a URL hash and back (base64url of UTF-8 JSON) */
export interface DemoState {
  source: SourceKind
  target: TargetKind
  format: TextFormat
  files: Record<string, string>
  options?: Partial<DemoOptions>
}

export const encodeState = (state: DemoState): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export const decodeState = (hash: string): DemoState | undefined => {
  try {
    const binary = atob(hash.replace(/-/g, "+").replace(/_/g, "/"))
    const state = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))),
    ) as DemoState
    const valid =
      SOURCES.some((item) => item.id === state.source) &&
      TARGETS.some((item) => item.id === state.target) &&
      (state.format === "yaml" || state.format === "json") &&
      !!state.files &&
      typeof state.files === "object" &&
      Object.values(state.files).every((text) => typeof text === "string")
    return valid ? state : undefined
  } catch {
    return undefined
  }
}
