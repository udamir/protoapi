# API reference

All functions are named exports of `protoapi`. `protoapi/core` exports the same names, with a smaller bundle (see [Imports and the bundle](/guide/imports#protoapi-core)).

```ts
import {
  buildFromProto,
  buildFromProtoAsync,
  buildFromDescriptorSet,
  buildFromDescriptorSetBinary,
  printProto,
  locatePointer,
  locateDiff,
  parseProto,
  bundledFiles,
  createProtoApi,
  defaultJsonName,
  normalizeComment,
} from "protoapi"
```

## Builders

Every builder returns a `BuildResult` and reports input problems as [issues](/guide/diagnostics); arguments of the wrong type throw a `TypeError`. The options are described in [Usage](/guide/usage#build-options).

```ts
interface BuildResult {
  document: ProtoApiDocument
  sourceMap: SourceMap
  issues: BuildIssue[]
}
```

### `buildFromProto(sources, options?)`

```ts
function buildFromProto(sources: Record<string, string>, options?: TextBuildOptions): BuildResult
```

Builds a document from `.proto` text. `sources` maps import paths to file contents; imports resolve from `sources`, then `options.bundle`, then the built-in bundle, then `options.loader`.

| Parameter | Type | Description |
| --- | --- | --- |
| `sources` | `Record<string, string>` | Import path → `.proto` text. Every key is an entry file unless `options.entry` is given. |
| `options` | `TextBuildOptions` | `BuildOptions` plus `loader?: (importPath: string) => string \| undefined`. |

### `buildFromProtoAsync(sources, options?)`

```ts
function buildFromProtoAsync(
  sources: Record<string, string>,
  options?: BuildOptions & { loader?: (importPath: string) => Promise<string | undefined> | string | undefined },
): Promise<BuildResult>
```

Like `buildFromProto`, with an asynchronous loader. Imports are discovered by parsing and loaded concurrently; a loader that throws or rejects makes that import missing. The promise never rejects on input problems.

### `buildFromDescriptorSet(set, options?)`

```ts
function buildFromDescriptorSet(set: FileDescriptorSetJson, options?: BuildOptions): BuildResult
```

Builds a document from a `FileDescriptorSet` or buf image in ProtoJSON (`{ file: [...] }`, camelCase or snake_case keys). Gives the same document as `buildFromProto` for the same files. The entry files are the files not marked `bufExtension.isImport`, unless `options.entry` is given.

### `buildFromDescriptorSetBinary(bytes, options?)`

```ts
function buildFromDescriptorSetBinary(
  bytes: Uint8Array,
  options?: BuildOptions & { decoder?: (bytes: Uint8Array) => FileDescriptorSetJson | Promise<FileDescriptorSetJson> },
): Promise<BuildResult>
```

Builds a document from a binary `FileDescriptorSet`. Decodes with `options.decoder`, else with the optional peer dependency `@bufbuild/protobuf` (2.8.0 or later; 2.16.0 or later for edition 2026).

## Printer

### `printProto(document, options?)`

```ts
function printProto(document: ProtoApiDocument, options?: PrintOptions): Record<string, string>

interface PrintOptions {
  indent?: string // default two spaces
  tags?: boolean | Partial<Record<TagName, string | false>> // default true
  fileName?: string // for documents without files, default "protoapi.proto"
  sources?: Record<string, string> // definitions the document does not hold
}
```

Prints a document as `.proto` files (import path → text), one per entry of `files` not marked `bundled`. Building the printed files gives the same document; see [Usage](/guide/usage#print-a-document-back-to-proto).

## Source maps

### `locatePointer(pointer, sourceMap)`

```ts
function locatePointer(pointer: JsonPointer, sourceMap: SourceMap): Location | undefined
```

The location of a document node, or of its nearest ancestor with an entry.

### `locateDiff(diff, beforeMap, afterMap)`

```ts
function locateDiff(diff: LocatableDiff, beforeMap: SourceMap, afterMap: SourceMap): Location | undefined
```

The location of an api-smart-diff 2.0 diff (`{ action, path, before?, after?, origin? }`): `remove` in the before map, `add`, `replace` and `rename` in the after map. See [Source maps](/guide/source-maps#locatediff).

## Parser

### `parseProto(text, path?)`

```ts
function parseProto(text: string, path?: string): ParseProtoResult

interface ParseProtoResult {
  ast: Proto // the statements; with a syntax error, the complete ones before it
  comments: (Comment | TextprotoComment)[] // every comment, in source order
  issues: BuildIssue[] // the syntax issue, if any
  error?: ParseError
}
```

The low-level parser of one file (default `path` `"input.proto"`), without resolving anything. Never throws on bad input.

## Bundles

### `bundledFiles`

```ts
const bundledFiles: Readonly<Record<string, string>>
```

The bundled `.proto` sources (import path → text): the whole bundle in `protoapi`, `descriptor.proto` and the feature files in `protoapi/core`. Versions are listed in `bundle/VERSIONS.md` of the package.

### `createProtoApi(bundle)`

```ts
function createProtoApi(bundle?: Readonly<Record<string, string>>): ProtoApi

interface ProtoApi {
  buildFromProto: typeof buildFromProto
  buildFromProtoAsync: typeof buildFromProtoAsync
  buildFromDescriptorSet: typeof buildFromDescriptorSet
  buildFromDescriptorSetBinary: typeof buildFromDescriptorSetBinary
  printProto: typeof printProto
  readonly bundledFiles: Readonly<Record<string, string>>
}
```

Creates the builders and the printer over a bundle of your own. See [Imports and the bundle](/guide/imports#createprotoapi-bundle).

## Helpers

### `defaultJsonName(name)`

```ts
function defaultJsonName(name: string): string
```

The JSON name protoc gives a field by default (`foo_bar` → `fooBar`, `_foo` → `Foo`, `foo__bar` → `fooBar`). A document writes `jsonName` only when the field's `json_name` differs from it, so `field.jsonName ?? defaultJsonName(key)` is the JSON name of any field.

### `normalizeComment(text)`

```ts
function normalizeComment(text: string | undefined): string | undefined
```

Normalizes comment text (without its `//` or `/* */` markers) the way descriptions are normalized: a leading `*` line and the common indentation are removed, horizontal whitespace runs collapse to one space, trailing whitespace is removed, blank lines are kept as one empty line; empty text gives `undefined`.

## Types

| Type | Description |
| --- | --- |
| `ProtoApiDocument` | A `protoapi: "0.1"` document: `files`, `services`, `components`. |
| `ProtoApiFile` | An entry of `files`: `syntax`, `package`, `imports`, `importFlags`, `options`, `description`, `bundled`. |
| `ProtoApiService`, `ProtoApiMethod`, `ProtoApiMethodMessage`, `ProtoApiHttpRule` | Services, methods, their request and response, and the `google.api.http` rule. |
| `ProtoApiMessage`, `ProtoApiField`, `ProtoApiReserved`, `ProtoApiExtensionRangeOptions` | Messages and their fields, reserved numbers and names, options of extension ranges. |
| `ProtoApiEnum`, `ProtoApiEnumValue` | Enums and their values. |
| `ProtoApiExtension` | An extension: a field with an `extendee`. |
| `ProtoApiScalarRef`, `ProtoApiNamedRef`, `ProtoApiTypeRef` | The type of `items`, `propertyNames` and `additionalProperties`. |
| `ProtoApiAnnotations` | The JSON Schema keywords of the annotation layer. |
| `ProtoApiElement` | What every element may carry: `title`, `file`, `description`, `deprecation`, `options`, `x-annotation-conflicts`. |
| `ProtoOptions`, `ProtoOptionValue` | Option maps and their values. |
| `AnnotationConflict`, `AnnotationSource` | An entry of `x-annotation-conflicts`. |
| `ProtoScalar`, `ProtoSyntax`, `KnownProtoSyntax` | Scalar type names, the `syntax` of a file. |
| `BuildOptions`, `TextBuildOptions`, `DescriptorBuildOptions`, `ImportsMode`, `TagName` | Build options. |
| `BuildResult`, `BuildIssue`, `BuildIssueCode` | Build results and issues. |
| `SourceMap`, `Location`, `Position`, `JsonPointer`, `LocatableDiff` | Source maps. |
| `PrintOptions` | Print options. |
| `ProtoSources`, `ProtoLoader`, `AsyncProtoLoader`, `FileDescriptorSetJson`, `DescriptorDecoder` | Inputs of the builders. |

The [specification](/spec/v0.1#_9-typescript-types) lists the document types in full.
