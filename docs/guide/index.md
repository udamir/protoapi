# What is ProtoApi?

ProtoApi is a document format that describes a Protocol Buffers API — a set of `.proto` files with their services, messages, enums and extensions — as plain JSON (or YAML). It is to protobuf and gRPC what OpenAPI is to REST and [GraphAPI](https://udamir.github.io/graphapi/) is to GraphQL: services and methods live on top, named types live under `components` keyed by their fully qualified name, and types refer to each other with `$ref`. Fields borrow the JSON Schema vocabulary where its meaning matches protobuf (`items`, `minimum`, `pattern`, `format`, …), write scalar types as protobuf names (`type: int64`), and use protobuf keywords where JSON Schema has none (`number`, `presence`, `oneof`, …).

The [`protoapi`](https://www.npmjs.com/package/protoapi) package is the reference implementation. It builds ProtoApi documents from `.proto` text or from a `FileDescriptorSet`, prints any document back to `.proto` text, and gives a source map that locates every node of the document in the original files.

```text
.proto text ─────────────buildFromProto─────────────┐
                                                     ├──► ProtoApi document + source map + issues ──printProto──► .proto text
FileDescriptorSet (buf image) ──buildFromDescriptorSet┘
```

## Why a separate format?

- **Readable and reviewable.** Services, methods, messages, fields and enum values are keyed by name, so a document reads top-down, and a change to a `.proto` file is a small, local change to the document.
- **Built for diffing.** Every component is keyed by its fully qualified name, fields carry their `number`, scalars are written the same way in every position, and defaults are omitted, so equal APIs give equal documents and a change shows up in one place. ProtoApi is the input format of [api-smart-diff](https://github.com/udamir/api-smart-diff) for protobuf and gRPC breaking-change detection.
- **Source agnostic.** The `.proto` parser and the `FileDescriptorSet` reader produce byte-identical documents — the same keys, the same values, the same order, the same descriptions — so documents can be compared regardless of how they were obtained. Every [conversion example](/examples/) is checked against the build of buf's descriptor set.
- **Lossless.** Comments, options (built-in and custom, typed), `json_name`, defaults, reserved ranges, extension ranges, groups, editions features and every annotation are kept, and `printProto` prints a document back to `.proto` files that build to the same document.
- **Annotations, normalized.** Validation and documentation conventions — comment tags such as `@Minimum 1`, AIP prefixes such as `Required.`, `google.api.field_behavior`, protovalidate, protoc-gen-validate and grpc-gateway options — are lifted into one set of JSON Schema keywords, with conflicts between sources recorded.
- **Located.** The source map gives, for every JSON pointer of the document, the span of the construct in the `.proto` files, so a diff or an issue can be shown at its line.

## What it supports

- proto2, proto3 and editions 2023, 2024 and 2026, with edition feature defaults read from `descriptor.proto`.
- Imports of every kind (`public`, `weak`, edition 2024 `import option`), with name lookup and symbol visibility as protoc implements them.
- Bundled definitions: the well-known types, `google/api`, `google/rpc`, `google/type`, protovalidate, protoc-gen-validate and grpc-gateway, so most imports resolve without any setup. See [Imports and the bundle](/guide/imports).
- A `.proto` parser in pure TypeScript that runs in the browser, and descriptor sets in ProtoJSON (`buf build -o image.json`) or binary (through the optional `@bufbuild/protobuf` peer dependency).
- Diagnostics in the style of buf for broken input, while still producing the most complete document the input allows. See [Diagnostics](/guide/diagnostics).
- No runtime dependencies; ESM, CommonJS and browser builds.

## The document

`protoapi` produces `protoapi: "0.1"` documents, defined by the [ProtoApi 0.1 specification](/spec/v0.1). The [specification overview](/spec/) shows a document next to its `.proto` file, the [conversion examples](/examples/) show one per feature, and the [online demo](/demo) builds one from your own files.

## Next steps

- [Getting started](/guide/getting-started) — install the package and build your first document.
- [Usage](/guide/usage) — every way to build, print and locate documents, and the build options.
- [Specification](/spec/) — the description of the document.
