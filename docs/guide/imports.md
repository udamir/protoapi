# Imports and the bundle

A `.proto` file rarely stands alone: it imports the well-known types, googleapis annotations, validation rules and files of its own project. This page explains where `protoapi` finds imported files, what it emits of them, and how to choose between the two entry points of the package.

## Where imports come from

`buildFromProto(sources, options)` resolves an `import "path";` statement from, in this order:

1. `sources` — the files you pass;
2. `options.bundle` — files you add to or override in the bundle;
3. the built-in bundle of the entry point (`protoapi` or `protoapi/core`);
4. `options.loader` — a function that loads a path on demand (see [Usage](/guide/usage#loading-imports-on-demand)).

An import that none of them has is a `missing-import` issue; the declarations of the file are then unknown, so references to them are `unresolved-type` issues.

Name lookup follows protoc: a type is visible through the file's own imports and their `import public` re-exports, never through imports of imports; `import weak` is resolved like a plain import; edition 2024 `import option` makes the file's definitions available to option names only; and edition 2024 symbol visibility (`export`, `local`, the edition defaults) is enforced across files.

## The bundle

`protoapi` ships the `.proto` sources of the definitions most APIs import, pinned to the versions in `bundle/VERSIONS.md`:

| Files                                                                                                                                                                                                                        | Origin                     | Licence      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ |
| `google/protobuf/*.proto` — `descriptor`, `any`, `timestamp`, `duration`, `empty`, `struct`, `wrappers`, `field_mask`, `api`, `type`, `source_context`, `cpp_features`, `java_features`                                      | protobuf v36.2             | BSD-3-Clause |
| `google/protobuf/go_features.proto`                                                                                                                                                                                          | protobuf-go v1.36.12       | BSD-3-Clause |
| `google/api/*.proto` (`annotations`, `http`, `field_behavior`, `field_info`, `client`, `resource`, `launch_stage`, `routing`, `visibility`), `google/rpc/*.proto` (`status`, `code`, `error_details`), `google/type/*.proto` | googleapis                 | Apache-2.0   |
| `buf/validate/validate.proto`                                                                                                                                                                                                | protovalidate v1.2.2       | Apache-2.0   |
| `validate/validate.proto`                                                                                                                                                                                                    | protoc-gen-validate v1.3.3 | Apache-2.0   |
| `protoc-gen-openapiv2/options/{annotations,openapiv2}.proto`                                                                                                                                                                 | grpc-gateway v2.33.0       | BSD-3-Clause |

The bundle serves three purposes: imports of these files resolve without any setup; option values of their extensions (`google.api.http`, `buf.validate.field`, …) are typed and [lifted into keywords](/guide/annotations); and `descriptor.proto` supplies the built-in options and the feature defaults of every edition. The sources are exported as `bundledFiles` (import path → text).

**Your files win.** A file you supply in `sources` or through the loader is used instead of the bundled file of the same path, and counts as a user file, even under a bundled path such as `google/protobuf/…`. A `descriptor.proto` of your own replaces the bundled one also when it is not imported, so its feature defaults apply. Use the `bundle` option to add or override files without making them user files:

```ts
buildFromProto(sources, { bundle: { "acme/options.proto": acmeOptions } })
```

## What a build emits

The **entry files** (`options.entry`, by default every key of `sources`) are always emitted in full: every service, message, enum and extension they declare. What is emitted of the files they import depends on the `imports` option:

| `imports`          | Entry files | Imported user files (`sources`, loader)                                | Imported bundled files       |
| ------------------ | ----------- | ---------------------------------------------------------------------- | ---------------------------- |
| `"user"` (default) | in full     | in full, when reachable from an entry file through imports of any kind | referenced declarations only |
| `"referenced"`     | in full     | referenced declarations only                                           | referenced declarations only |
| `"all"`            | in full     | in full                                                                | in full                      |

"Referenced declarations" are the types used by emitted declarations, transitively: field, map value and method types (the extendees of extensions are not followed). So with the default mode, a document contains your whole API and exactly the well-known and googleapis types it uses:

```ts
buildFromProto(
  {
    "shop/v1/api.proto": api, // imports types.proto and google/protobuf/empty.proto
    "shop/v1/types.proto": types, // declares Item, used by api.proto, and Unused
    "common/v1/money.proto": money, // re-exported by types.proto with import public
  },
  { entry: ["shop/v1/api.proto"] },
)
// "user":       common.v1.Money, shop.v1.Item, shop.v1.Unused, google.protobuf.Empty, shop.v1.GetRequest
// "referenced": common.v1.Money, shop.v1.Item,                 google.protobuf.Empty, shop.v1.GetRequest
```

The [imports example](/examples/#imports-and-bundled-files) shows the full document.

### The `bundled` marker

A file the build resolved from the bundle (built-in or `options.bundle`) that is not an entry file is marked `bundled: true` in `files`, in every mode:

```yaml
files:
  google/protobuf/empty.proto:
    syntax: proto3
    package: google.protobuf
    options: { … }
    bundled: true
  shop/v1/api.proto: { … }
```

A bundled file carries no header `description` (the licence comment of the bundled sources stays out of documents), and `printProto` does not print it: building the printed files again resolves it from the bundle, which is what makes the round trip of a default build work from the printed files alone.

The descriptor builders mark a file of the set as bundled when its path is a key of the bundle in effect: the whole bundle with `protoapi`, `descriptor.proto` and the feature files with `protoapi/core`, plus `options.bundle`.

::: tip Diffing
api-smart-diff compares documents built with the default `imports: "user"`: your own files are compared in full, and only the parts of bundled files your API uses take part. Build both documents of a comparison with the same mode — the mode is not recorded in the document.
:::

## `protoapi/core`

The bundled sources are about 97 KB of the 158 KB gzipped browser build. When you do not need them — a server that always builds from descriptor sets that include their imports, or a page that loads the definitions itself — import `protoapi/core`:

```ts
import { buildFromDescriptorSet, printProto } from "protoapi/core"
```

`protoapi/core` has the same API, with only `google/protobuf/descriptor.proto` and the `cpp_features`, `java_features` and `go_features` files bundled, so built-in options and `features.*` are still typed without anything supplied (about 60 KB gzipped of code, 78 KB for `browser/protoapi-core.min.js`, global `protoapiCore`). Imports of the well-known types, googleapis, protovalidate, PGV and grpc-gateway must then come from `sources`, a loader, the `bundle` option or the descriptor set:

```ts
import { buildFromProto } from "protoapi/core"

buildFromProto({ "a.proto": `syntax = "proto3"; import "google/protobuf/empty.proto"; …` })
// issues: missing-import: import "google/protobuf/empty.proto" not found, …
```

### `createProtoApi(bundle)`

`createProtoApi` creates the whole API — the four builders, `printProto` and `bundledFiles` — over a bundle you provide. Combined with `protoapi/core`, it lets you load the full bundle lazily:

```ts
import { createProtoApi } from "protoapi/core"

const { bundledFiles } = await import("protoapi") // a separate chunk
const api = createProtoApi(bundledFiles)
const { document } = api.buildFromProto(sources)
```

or serve a bundle of your own, for example your company's shared definitions:

```ts
import { bundledFiles, createProtoApi } from "protoapi/core"

const api = createProtoApi({ ...bundledFiles, "acme/options.proto": acmeOptions })
```
