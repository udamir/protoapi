# protoapi

ProtoApi is a JSON document format for Protocol Buffers APIs, plus the tools that convert to and from it: `.proto` text → ProtoApi, `FileDescriptorSet` → ProtoApi, ProtoApi → `.proto` text, and a source map that locates every document node in the original files. It is the protobuf counterpart of [gqlapi](https://github.com/udamir/graphapi) and the input format of [api-smart-diff](https://github.com/udamir/api-smart-diff) for protobuf and gRPC diffs.

- proto2, proto3, editions 2023, 2024 and 2026; edition feature defaults are read from `descriptor.proto` (`FeatureSetDefaults`), and a `descriptor.proto` of your own wins over the bundled one. An edition this version does not know (`UNSTABLE`, a future edition) is written verbatim in `syntax` with an `unsupported` issue and resolved with the edition 2026 defaults.
- two producers with byte-identical output: pure TypeScript `.proto` parser (browser-capable) and `FileDescriptorSet` (ProtoJSON from `buf build -o image.json`, or binary through `@bufbuild/protobuf`)
- annotation layer: comment tags (`@Minimum 1`, `@Format email`, …), AIP prefixes (`Required.`, `Output only.`, …), `google.api.field_behavior` / `field_info`, protovalidate, protoc-gen-validate and grpc-gateway rules lifted into JSON Schema keywords
- bundled definitions (protobuf v36.2, see `bundle/VERSIONS.md`): well-known types, `cpp_features`, `java_features`, `go_features` (protobuf-go), `google/api`, `google/rpc`, `google/type`, `buf/validate`, `validate`, `protoc-gen-openapiv2`
- no runtime dependencies

## Install

```sh
npm install protoapi
```

| Entry | |
|---|---|
| `protoapi` | the API with the bundled definitions (`browser/protoapi.min.js` about 158 KB gzip, of which the bundled `.proto` sources are about 97 KB) |
| `protoapi/core` | the same API without the convention sources: about 60 KB gzip of code (minified, without any bundled `.proto` text), about 78 KB gzip for `browser/protoapi-core.min.js` with the core sources below. It keeps `google/protobuf/descriptor.proto` and `cpp_features` / `java_features` / `go_features.proto`, so built-in options and `features.*` are typed without anything supplied. Imports of the well-known types, googleapis, protovalidate, PGV and grpc-gateway must come from `sources`, a loader, the `bundle` option or the descriptor set. `createProtoApi(bundle)` creates the API over a bundle you load yourself (for example `bundledFiles` of `protoapi`, imported lazily). |

ESM and CommonJS builds are in `dist/`; the `browser` field points at the ESM build. `browser/protoapi.min.js` (global `protoapi`, also the `unpkg` / `jsdelivr` file) and `browser/protoapi-core.min.js` (global `protoapiCore`) are minified IIFEs for `<script>` tags.

## Usage

```ts
import { buildFromProto, buildFromDescriptorSet, printProto, locateDiff } from "protoapi"

const { document, sourceMap, issues } = buildFromProto({
  "shop/v1/pet.proto": `
    syntax = "proto3";
    package shop.v1;
    import "google/protobuf/timestamp.proto";
    // A pet.
    message Pet {
      // Required. Unique id.
      int64 id = 1;
      optional string nickname = 2;
      google.protobuf.Timestamp created_at = 3;
    }
    service PetService { rpc GetPet(Pet) returns (stream Pet); }
  `,
})
```

```yaml
protoapi: "0.1"
files:                                     # dependencies first
  google/protobuf/timestamp.proto: { syntax: proto3, package: google.protobuf, options: { … }, bundled: true }
  shop/v1/pet.proto: { syntax: proto3, package: shop.v1, imports: [google/protobuf/timestamp.proto] }
services:
  shop.v1.PetService:
    title: PetService
    file: shop/v1/pet.proto
    methods:
      GetPet:
        request: { schema: { $ref: "#/components/messages/shop.v1.Pet" } }
        response: { schema: { $ref: "#/components/messages/shop.v1.Pet" }, stream: true }
components:
  messages:
    shop.v1.Pet:
      title: Pet
      file: shop/v1/pet.proto
      description: A pet.
      type: object
      properties:
        id: { description: Unique id., number: 1, type: integer, protoType: int64, required: true }
        nickname: { number: 2, type: string, protoType: string, presence: explicit }
        created_at: { number: 3, $ref: "#/components/messages/google.protobuf.Timestamp" }
    google.protobuf.Timestamp: { … }
```

Imports are emitted by `imports` (default `"user"`): the entry files and every file you supply (in `sources` or through the loader) that they reach through imports of any kind (plain, `public`, `weak`, edition 2024 `import option`) are emitted in full; a file resolved from the bundle (the built-in one or the `bundle` option) contributes only the declarations referenced from emitted ones (field, map value and method types; extendees are not followed) and is marked `bundled: true` in `files` unless it is an entry file. A file you supply is a user file even under a bundled path such as `google/protobuf/…`. Bundled files carry no header `description` (their licence comment), in every mode; user files and entry files keep theirs. The descriptor producer treats a set file as bundled when its path is a key of the bundle in effect (`protoapi`: the whole bundle, `protoapi/core`: `descriptor.proto` and the feature files, plus the `bundle` option). `"referenced"` emits the entry files in full and only referenced declarations of every imported file (what `includeImports: false` did), `"all"` every file of the build. api-smart-diff compares documents built with the default `"user"`: build both documents of a comparison with it.

From a buf image:

```ts
import { readFileSync } from "node:fs"
const image = JSON.parse(readFileSync("image.json", "utf8")) // buf build -o image.json
const result = buildFromDescriptorSet(image)
```

Binary descriptor sets need the optional peer dependency `@bufbuild/protobuf` >= 2.8.0 (edition 2024; >= 2.16.0 for edition 2026), or your own decoder. Those `@bufbuild/protobuf` releases need Node 20+, while protoapi itself (text and ProtoJSON input) supports Node 18.

```ts
const result = await buildFromDescriptorSetBinary(bytes) // or { decoder: (bytes) => fileDescriptorSetJson }
```

Custom options are decoded with a registry built per file from the set plus the bundled definitions, so thin sets (`protoc` without `--include_imports`, `buf build --exclude-imports`) keep `google.api.http`, `field_behavior` and protovalidate rules. A file the decoder cannot load (an edition newer than the installed `@bufbuild/protobuf`, a missing import) is an `unsupported` issue, and an option without a definition anywhere is an `unknown-option` issue; the other files are not affected. buf's `bufExtension.isImport` is read from binary images too. A missing or 1.x `@bufbuild/protobuf` is an `unsupported` issue with a version hint.

Back to `.proto` text (one text per file; `build(print(build(x)))` equals `build(x)` except for `x-annotation-conflicts`):

```ts
const files: Record<string, string> = printProto(document)
// files marked bundled are not printed (they resolve from the bundle when rebuilt); a document built with
// imports: "referenced" holds only the referenced types of imported files: pass the sources so that option values
// defined there print with their types
const same = printProto(result.document, { sources })
```

Lifted keywords print back as the convention option they come from when the file's imports (or their public re-exports) make it available, in the precedence order of the annotation layer (`google.api` → protovalidate → PGV → openapiv2); otherwise as comment tags (`@Minimum 1`, `@Enum RED, BLUE`) or AIP prefixes (`Immutable.`). Pass `tags: false` for documents built with `annotations: "options"` or `"none"`, and the build's `tags` map for renamed tags. Resolved features (`packed`, `utf8Validation`, `jsonFormat`) and inherited editions features print in the spelling of the file's syntax, groups as groups (also in `extend` blocks), `Any` values in the expanded `[type.googleapis.com/T] { … }` form, unknown editions verbatim. Documents without `files` print into `fileName` with the syntax inferred from the content and the longest common package prefix of the keys; types the bundle declares are imported.

## API

| Function | |
|---|---|
| `buildFromProto(sources, options?)` | `sources`: import path → text. Imports resolve from `sources`, then `options.bundle`, then the built-in bundle, then `options.loader`. |
| `buildFromProtoAsync(sources, options?)` | same, with an async `loader` |
| `buildFromDescriptorSet(set, options?)` | ProtoJSON `FileDescriptorSet` / buf image; camelCase or snake_case keys |
| `buildFromDescriptorSetBinary(bytes, options?)` | async; `options.decoder` or `@bufbuild/protobuf` |
| `printProto(document, options?)` | `{ indent?, tags?, fileName?, sources? }` → `Record<path, text>`; `tags`: `true` (default), `false`, or the build's rename map; `sources`: definitions the document does not hold |
| `locatePointer(pointer, sourceMap)` | location of a node or its nearest ancestor |
| `locateDiff(diff, beforeMap, afterMap)` | location of an api-smart-diff 2.0 diff (`{ action, path, before?, after?, origin? }`): `remove` in the before map, `add` / `replace` / `rename` in the after map (a rename's `path` is the container, `after` the new key); `reserved` / `extensions` indices the written range, `$ref` leaves the type name |
| `parseProto(text, path?)` | low-level parser: `{ ast, comments, issues }`; on a syntax error the AST holds the complete statements before it and `issues` the `syntax` issue (located like the builders do) |
| `bundledFiles` | the bundled `.proto` sources (`descriptor.proto` and the feature files in `protoapi/core`) |
| `createProtoApi(bundle)` | all builders and `printProto` over a bundle of your own (import path → text) |

Every builder returns `{ document, sourceMap, issues }` and never throws on input problems; issues carry `code`, `message`, `file`, `location` and the document `pointer`. Wrong argument types (sources that are not an object of strings, a set without a `file` array, bytes that are not a `Uint8Array`, options of the wrong type) are programming errors and throw a `TypeError`, synchronously also for the async builders; so do `printProto`, `parseProto`, `locatePointer` and `locateDiff`. `printProto` prints documents with missing optional parts. Build options:

| Option | Default | |
|---|---|---|
| `entry` | all `sources` keys / non-import descriptor files | files whose declarations are always emitted in full |
| `imports` | `"user"` | `"user"`: entry files and every non-bundled file they import (any kind, transitively) in full, bundled files referenced declarations only; `"referenced"`: entry files in full, imported files referenced declarations only; `"all"`: every file in full |
| `includeImports` | — | deprecated alias: `true` is `imports: "all"`, `false` is `imports: "referenced"`; contradicting `imports` is a `TypeError` |
| `annotations` | `"all"` | `"all"` tags + prefixes + options, `"options"` options only, `"none"` convention options stay raw |
| `tags` | — | rename (`{ default: "DefaultValue" }`) or disable (`{ example: false }`) comment tags |
| `sourceMap` | `true` | |
| `files` | `true` | emit the `files` section and `file` keys |
| `bundle` | — | add or override bundled files (a `descriptor.proto` in `sources` wins over the bundle, also when not imported) |
| `tabWidth` | `4` | text producer only: a tab advances source-map and issue columns to the next multiple (buf's tab stop; protoc uses 8). `\r`, `\f`, `\v` and a byte order mark have no width, as in buf |

Issue codes: `syntax`, `missing-import`, `unresolved-type` (also a name of the wrong kind: an enum as an rpc type, a message as a map key, an option name that is not an extension), `unresolved-extendee`, `unknown-option`, `invalid-option` (values out of range, unknown enum values, non-canonical literals, options on the wrong target, …), `invalid-number`, `duplicate-number`, `duplicate-name` (also JSON-name and C++ scoping clashes), `reserved-conflict`, `annotation-conflict`, `invalid-tag`, `unsupported`, `no-source-info` and `invalid-definition`: a syntax or edition rule is broken (proto3 `required` or groups, editions labels, options or keywords not available in the file's edition, naming style in edition 2024+, import cycles, statement order). The text producer checks the definitions of every file it builds that is not bundled, as buf does; the document stays as complete as the input allows.

## Format in short

- Services and methods on top; messages, enums and extensions under `components`, keyed by fully qualified name (`pkg.Outer.Inner`).
- Fields are keyed by name and carry `number`; scalars are `{ type, protoType }`; message and enum fields are nominal `$ref`s (siblings of `$ref` are field attributes, never schema overrides); `repeated` → `type: array, items`; `map<K, V>` → `type: object, propertyNames, additionalProperties`.
- protobuf keywords: `presence: explicit | required`, `oneof` + `oneofs`, `jsonName` (only when different from the default), `default` (proto2 / editions), `delimited` (groups / `DELIMITED`), `reserved`, `extensions`, `extendee`, `closed` (closed enums), `options` (everything not lifted, typed, snake_case keys).
- Canonical values: 64-bit integers as decimal strings, `"Infinity"` / `"-Infinity"` / `"NaN"`, bytes as base64, enums as names; options equal to their default are not written.
- `files[path].bundled: true` marks a file resolved from the bundle that is not an entry file; it has no header `description` and is not printed by `printProto`.
- `required: true` on a field is annotation-level requiredness (`@Required`, the `Required.` prefix, `field_behavior = REQUIRED`, protovalidate / PGV `required`, the fields named by `openapiv2_schema.json_schema.required`); wire-level requiredness (a `required` label, `LEGACY_REQUIRED`) is `presence: required` and never sets the keyword. Messages carry no `required` array: a strict JSON Schema projection rebuilds it from the fields that carry the keyword.
- Descriptions come from an element's leading and trailing comments, attached as buf 1.75 attaches them (`SourceCodeInfo`), so both producers agree for a buf-built set; the detached comments above the first statement are the file's header `description`.
- Source map: one entry per element and sub-element (design §9), one per `reserved` / `extensions` interval and reserved name (the written range), per `extensionOptions` range, and keyword entries: a keyword lifted from an option points at the option statement, one from a comment tag or AIP prefix at the tag line (leading `//` comments), resolved keywords at the feature option that sets them, a field's `required` named by `openapiv2_schema.json_schema.required` at the message's option statement. Both producers give the same pointers and spans.

The full specification, with about 85 proto → ProtoApi examples, is the design document `PROTOAPI_PACKAGE_DESIGN.md` in the api-smart-diff repository (`docs/`).

## Development

```sh
bun install
bun test                    # all tests (PB-1 … PB-9)
bun run typecheck
bun run check               # biome
bun run build               # dist/ + browser/
bun run test:dist           # smoke tests of both entries (CommonJS and ESM) after the build
bun scripts/images.ts       # regenerate buf images for the conformance fixtures and the bundle (needs the buf devDependency)
bun scripts/case-images.ts  # record buf's verdict on the inline test cases (test/cases/*.ts)
bun scripts/print-check.ts  # record that the printed text of every round-trip input passes buf build (PB-7.12)
bun scripts/comment-fuzz.ts check 2000  # differential comment fuzz against buf (random layouts); without `check` it rewrites the named/comments-fuzz fixture
bun scripts/fetch-corpus.ts && bun scripts/fetch-breaking.ts  # googleapis samples, buf's breaking test corpus
bun scripts/fetch-bundle.ts && bun scripts/gen-bundle.ts   # update the bundled definitions
bun bench/bench.ts --descriptor                            # performance
```

## Licence

MIT. The parser is derived from [pbkit](https://github.com/riiid/pbkit) 0.0.72 (MIT OR Apache-2.0), see `src/parser/NOTICE`. Bundled `.proto` definitions keep their licences (BSD-3-Clause: protobuf, protobuf-go, grpc-gateway; Apache-2.0: googleapis, protovalidate, protoc-gen-validate), see `NOTICE` and `bundle/LICENSES/`.
