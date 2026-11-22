# Usage

All functions are named exports of `protoapi` (and of `protoapi/core`, see [Imports and the bundle](/guide/imports#protoapi-core)). Every builder returns the same result:

```ts
interface BuildResult {
  document: ProtoApiDocument // the protoapi: "0.1" document
  sourceMap: SourceMap // JSON pointer -> { file, start, end }
  issues: BuildIssue[] // problems of the input; empty for valid input
}
```

Builders never throw on input problems: a missing import, an unresolved type or a syntax error is an [issue](/guide/diagnostics), and the document is as complete as the input allows. Wrong argument types (sources that are not an object of strings, a set without a `file` array, bytes that are not a `Uint8Array`, options of the wrong type) are programming errors and throw a `TypeError` — synchronously, also for the async builders.

## From `.proto` text

```ts
import { buildFromProto } from "protoapi"

const { document, sourceMap, issues } = buildFromProto({
  "shop/v1/pet.proto": petProto,
  "shop/v1/types.proto": typesProto,
})
```

`sources` maps import paths to file contents. An `import "x.proto"` statement resolves, in this order, from `sources`, from the [`bundle` option](#build-options), from the built-in [bundle](/guide/imports) (well-known types, googleapis, protovalidate, …), and finally from `options.loader`. An import that none of them has is a `missing-import` issue.

By default every key of `sources` is an entry file. Pass `entry` to emit only some files in full and resolve the others as imports:

```ts
buildFromProto(allFiles, { entry: ["shop/v1/pet.proto"] })
```

### Loading imports on demand

A `loader` is called with an import path for every import not found in `sources` or the bundle, and returns the file text or `undefined`:

```ts
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const root = "proto"
const result = buildFromProto(
  { "shop/v1/pet.proto": readFileSync(join(root, "shop/v1/pet.proto"), "utf8") },
  { loader: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : undefined) },
)
```

Files returned by the loader are user files, like the files of `sources`: with the default `imports: "user"` they are emitted in full when an entry file reaches them (see [Imports and the bundle](/guide/imports#what-a-build-emits)).

`buildFromProtoAsync` takes an asynchronous loader, for example one that fetches files over HTTP. It discovers the imports by parsing each file and loads them concurrently; a loader that throws, rejects or returns something other than a string makes that one import missing, and the build itself never rejects:

```ts
import { buildFromProtoAsync } from "protoapi"

const result = await buildFromProtoAsync(
  { "shop/v1/pet.proto": petProto },
  { loader: async (path) => (await fetch(`https://example.com/proto/${path}`)).text() },
)
```

## From a descriptor set

`buildFromDescriptorSet` reads a `FileDescriptorSet` in ProtoJSON, the format of `buf build -o image.json` (a buf image is a `FileDescriptorSet` with buf extensions). It gives **byte-identical** documents to `buildFromProto` for the same files, so it is the way to build documents in a pipeline that already compiles `.proto` files with buf or protoc.

```sh
buf build -o image.json
```

```ts
import { readFileSync } from "node:fs"
import { buildFromDescriptorSet } from "protoapi"

const image = JSON.parse(readFileSync("image.json", "utf8"))
const { document, sourceMap, issues } = buildFromDescriptorSet(image)
```

- Keys may be camelCase (ProtoJSON) or snake_case (`protoc --decode` style JSON).
- The entry files are the files buf did not mark as imports (`bufExtension.isImport`), or every file; pass `entry` to choose.
- Descriptions and the source map come from `sourceCodeInfo`. buf includes it by default; with protoc pass `--include_source_info`. A file without it gives a `no-source-info` issue and a document without descriptions or source map entries.
- Thin sets (`protoc` without `--include_imports`, `buf build --exclude-imports`) work: custom options are decoded with the definitions of the set plus the bundled ones, so `google.api.http`, `field_behavior` and protovalidate rules are still typed and lifted.
- A file of the set whose path is a key of the bundle in effect is treated as bundled (see [Imports and the bundle](/guide/imports)).

### From a binary descriptor set

```sh
buf build -o image.binpb
# or: protoc --include_imports --include_source_info --descriptor_set_out=image.binpb …
```

```ts
import { readFileSync } from "node:fs"
import { buildFromDescriptorSetBinary } from "protoapi"

const result = await buildFromDescriptorSetBinary(new Uint8Array(readFileSync("image.binpb")))
```

`buildFromDescriptorSetBinary` is asynchronous. It decodes the bytes with the optional peer dependency `@bufbuild/protobuf` (2.8.0 or later for edition 2024, 2.16.0 or later for edition 2026), loaded on demand; those releases need Node.js 20 or later. Custom options are decoded with a registry built per file from the set plus the bundled definitions. A missing or 1.x `@bufbuild/protobuf`, or a file the decoder cannot load (an edition newer than the installed version, a missing import), is an `unsupported` issue; an option without a definition anywhere is an `unknown-option` issue. buf's `isImport` flag is read from binary images too.

To use another decoder, pass `decoder`, a function from bytes to the ProtoJSON form (sync or async):

```ts
const result = await buildFromDescriptorSetBinary(bytes, {
  decoder: (bytes) => myDecoder.toJson(bytes), // -> { file: [...] }
})
```

## Build options

All builders take the same options (`loader` only for the text builders, `decoder` only for the binary one, `tabWidth` only for text):

| Option           | Default                                                   | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entry`          | every key of `sources` / every non-import file of the set | Files whose declarations are always emitted in full.                                                                                                                                                                                                                                                                                                                                     |
| `imports`        | `"user"`                                                  | What is emitted of imported files: `"user"` emits entry files and every non-bundled file they reach through imports in full, and only the referenced declarations of bundled files; `"referenced"` emits entry files in full and only referenced declarations of every imported file; `"all"` emits every file in full. See [Imports and the bundle](/guide/imports#what-a-build-emits). |
| `includeImports` | —                                                         | Deprecated alias: `true` is `imports: "all"`, `false` is `imports: "referenced"`. Contradicting `imports` is a `TypeError`.                                                                                                                                                                                                                                                              |
| `annotations`    | `"all"`                                                   | `"all"`: comment tags, AIP prefixes and convention options are lifted into keywords; `"options"`: convention options only; `"none"`: nothing is lifted, every option stays under `options` raw. See [Annotations](/guide/annotations).                                                                                                                                                   |
| `tags`           | —                                                         | Rename comment tags (`{ default: "DefaultValue" }`) or disable them (`{ example: false }`).                                                                                                                                                                                                                                                                                              |
| `sourceMap`      | `true`                                                    | Build the source map; `false` returns an empty map and saves time.                                                                                                                                                                                                                                                                                                                       |
| `files`          | `true`                                                    | Emit the `files` section and the `file` keys of services and components.                                                                                                                                                                                                                                                                                                                 |
| `bundle`         | —                                                         | Add or override bundled files (import path → text). A `descriptor.proto` in `sources` wins over the bundle, also when it is not imported.                                                                                                                                                                                                                                                |
| `tabWidth`       | `4`                                                       | Text only: a tab advances source-map and issue columns to the next multiple (buf's tab stop; protoc uses 8). `\r`, `\f`, `\v` and a byte order mark have no width, as in buf.                                                                                                                                                                                                            |
| `loader`         | —                                                         | Text only: load an import not found in `sources` or the bundle (`buildFromProtoAsync`: may return a promise).                                                                                                                                                                                                                                                                            |
| `decoder`        | `@bufbuild/protobuf`                                      | Binary only: decode a binary set into ProtoJSON.                                                                                                                                                                                                                                                                                                                                         |

::: warning Compare documents built the same way
`imports`, `annotations` and `tags` change what a document contains, and they are not recorded in it. Build both documents of a comparison with the same options — api-smart-diff expects the default `imports: "user"`.
:::

## Print a document back to `.proto`

```ts
import { printProto } from "protoapi"

const files: Record<string, string> = printProto(document)
```

`printProto` returns one text per file of `files` that is not marked `bundled` (bundled files resolve from the bundle when the printed files are built again). Each file gets its header comment, `syntax` or `edition`, `package`, imports, file options, then its declarations in document order, with nested types re-nested. The output is canonical: two-space indentation, one declaration per line, options in a stable order.

**Round trip.** `buildFromProto(printProto(document)).document` deep-equals `document` for a document built with the default options; with `imports: "all"`, build the printed files in place of their sources; with `imports: "referenced"`, build the printed entry files over the original imports. The only exception is `x-annotation-conflicts`: after printing, a conflict has one source left. See the [round-trip badge](/examples/) of each example.

**Lifted keywords** print as the convention option they can come from when the file imports its definition (`google.api.field_behavior`, `field_info`, protovalidate, PGV, openapiv2, in that order); otherwise as a comment tag (`// @Minimum 1`) or an AIP prefix (`Required.`), so the information survives without adding imports. `deprecation.reason` prints as a first comment line `Deprecated: <reason>`. Resolved features print in the spelling of the file's syntax (`[packed = false]` in proto3, `features.repeated_field_encoding = EXPANDED` in editions).

| Option     | Default            | Description                                                                                                                                                                                                                                                                              |
| ---------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `indent`   | two spaces         | The indentation unit.                                                                                                                                                                                                                                                                    |
| `tags`     | `true`             | `true` prints comment tags, prefixes and `Deprecated:` lines for keywords no available option can carry; `false` prints none (use it for documents built with `annotations: "options"` or `"none"`); a map renames or disables tags like the build option `tags` (pass the build's map). |
| `fileName` | `"protoapi.proto"` | The file name for documents without `files`.                                                                                                                                                                                                                                             |
| `sources`  | —                  | `.proto` sources whose definitions type option values the document does not hold — typically the build's own sources when it ran with `imports: "referenced"`. Bundled files are always consulted.                                                                                       |

### Documents without `files`

A document built with `files: false`, or written by hand, prints too. The syntax is inferred from the content (visibility keywords → edition 2024, features → 2023, proto2 constructs → proto2, else proto3), the package is the longest common package prefix of the keys, and types the bundle declares are imported. Keys of several packages give one file per package.

## Locate nodes

```ts
import { locatePointer, locateDiff } from "protoapi"

locatePointer("#/components/messages/shop.v1.Pet/properties/id/number", sourceMap)
// { file: "shop/v1/pet.proto", start: { line: 29, column: 13 }, end: { line: 29, column: 14 } } — the "1" of `int64 id = 1;`
```

`locatePointer` returns the location of a node, or of its nearest ancestor with an entry. `locateDiff` locates an api-smart-diff diff in the before or after source map. See [Source maps](/guide/source-maps).

## Parse only

`parseProto(text, path?)` is the low-level parser behind `buildFromProto`: it returns `{ ast, comments, issues }` for one file, without resolving anything. On a syntax error, the AST holds the complete statements before it and `issues` the `syntax` issue, located like the builders locate it.

```ts
import { parseProto } from "protoapi"

const { ast, comments, issues } = parseProto(text, "shop/v1/pet.proto")
```
