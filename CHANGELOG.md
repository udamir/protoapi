# Changelog

## 0.1.0 (2026-11-25)

First release of protoapi: the ProtoApi 0.1 document format for Protocol Buffers APIs, two producers (`.proto` text and `FileDescriptorSet`), a printer back to `.proto` text, and a source map for every document. Requires Node.js 18 or later; runs in browsers.

### Format

- ProtoApi 0.1 ([specification](https://udamir.github.io/protoapi/spec/v0.1)), marked by `protoapi: "0.1"`: files, services and methods (streaming, idempotency, HTTP rules), messages with fields, oneofs, reserved and extension ranges, enums and values, extensions and custom option definitions, comments as `description`, options as typed canonical values.
- Scalar positions (fields, `items`, map keys and values) write the protobuf scalar type in `type` (`type: int64`, `type: bytes`); `array` and `object` mark repeated and map fields.
- Annotation-level requiredness is the field keyword `required: true`; wire-level requiredness (a `required` label, `LEGACY_REQUIRED`) is `presence: required`.
- A JSON Schema (draft 2020-12) of the format ships as `protoapi/schemas/v0.1/schema.json` and is served at its `$id`, https://udamir.github.io/protoapi/schemas/v0.1/schema.json.

### API

- `buildFromProto`, `buildFromProtoAsync` (async loader; imports are discovered by parsing), `buildFromDescriptorSet` (ProtoJSON, e.g. `buf build -o image.json`), `buildFromDescriptorSetBinary` (through the optional peer `@bufbuild/protobuf` >= 2.8.0), `printProto`, `locatePointer`, `locateDiff`, `parseProto`, `defaultJsonName`, `normalizeComment`, `createProtoApi` and `bundledFiles` (the bundled `.proto` sources).
- Entries: `protoapi` (with the bundled definitions), `protoapi/core` (the same API without the convention sources; it keeps `descriptor.proto` and the language feature files), ESM and CommonJS builds, and minified browser builds `browser/protoapi.min.js` (global `protoapi`) and `browser/protoapi-core.min.js` (global `protoapiCore`).
- `BuildOptions`: `entry`; `imports` — `"user"` (default: entry files and every file you supply in full, bundled files only for the declarations referenced from emitted ones), `"referenced"` or `"all"`, with `includeImports` as a deprecated alias (a conflicting combination throws a `TypeError`); `annotations` (`"all"`, `"options"`, `"none"`); `tags` (rename or disable comment tags); `sourceMap`; `files`; `bundle` (override or add bundled files); `tabWidth` (text producer columns, default 4 as in buf).
- A build never throws on invalid input: it returns the most complete document the input allows with issues (`syntax`, `missing-import`, `unresolved-type`, `unresolved-extendee`, `unknown-option`, `invalid-option`, `invalid-number`, `duplicate-number`, `duplicate-name`, `reserved-conflict`, `annotation-conflict`, `invalid-tag`, `unsupported`, `no-source-info`, `invalid-definition`).

### Producers

- Syntaxes proto2, proto3 and editions 2023, 2024 and 2026; edition feature defaults come from the build's `descriptor.proto` (`FeatureSetDefaults`), a `descriptor.proto` of your own winning over the bundled one; an unknown edition is kept verbatim and reported as `unsupported`.
- Both producers give byte-identical documents and source maps for the same files, with buf 1.75 as the reference: protoc's import-visibility-aware name lookup (method request / response types and extendees take the first symbol of any kind, as protoc and buf do), edition 2024+ symbol visibility (`export` / `local`, `default_symbol_visibility`), `import option`, and definition checks for syntax and edition rules, naming styles, removed options and import cycles (`invalid-definition`).
- Comments are attached as buf 1.75 attaches them. protoc differs only in rare layouts: a block comment after a declaration's `;` or a block's `}` followed by a newline, a block comment between `{` and `}` on one line, a block comment followed by a `//` comment on the declaration's line, a block comment that ends on the line of the next token, a `//` group between a same-line trailing comment and a blank line, and comments after the last token of a file.
- Syntax errors are reported at the first error, as buf reports them; string literal escapes follow buf (a surrogate `\u` / `\U` escape or a code point above U+10FFFF is an "invalid escape sequence").
- Option values are typed against their definitions (built-in, bundled or in the input): text-format aggregates including `Any` in its expanded and `type_url` / `value` forms, map entries (a missing key or value is the zero value of its type), ProtoJSON values of the well-known types (`Timestamp` in its RFC 3339 form). An option without a definition is kept as written and reported.
- Binary descriptor sets decode custom options with a per-file registry built from the set and the bundle; an option value that has no ProtoJSON form is decoded from its wire bytes, so it does not affect the file's other options.
- Names that are also members of `Object.prototype` (`constructor`, `toString`, `__proto__`, …) are ordinary names everywhere.

### Annotation layer

- Comment tags (`@Minimum 1`, `@Format email`, …), AIP prefixes (`Required.`, `Output only.`, …), `google.api.field_behavior` / `field_info`, protovalidate (`buf.validate`), protoc-gen-validate (`validate.rules`) and grpc-gateway openapiv2 options are lifted into JSON Schema keywords, with the precedence option → `google.api` → protovalidate → PGV → openapiv2 → tags and prefixes; sources that disagree are recorded in `x-annotation-conflicts`.

### Printer

- `printProto` prints a document back to `.proto` files that build to the same document (except `x-annotation-conflicts`), in the spelling of each file's syntax; annotation keywords print as the convention option they came from when its definition is imported, otherwise as a comment tag or AIP prefix.
- Imports are the written list, with an import added only when a referenced type or option is not visible; an `import option` that a type needs becomes a plain import, and added imports come before the `import option` lines. Files marked `bundled` are not printed.
- Nested types whose parent messages are missing from the document print inside wrapper messages; type names are shortened only where no type, member or method of an enclosing scope hides them. Documents without `files` print with the syntax inferred from their content.

### Bundled definitions

- protobuf v36.2 (well-known types, `descriptor.proto`, `cpp_features`, `java_features`), protobuf-go v1.36.12 (`go_features.proto`), googleapis (`google/api`, `google/rpc`, `google/type`), protovalidate v1.2.2, protoc-gen-validate v1.3.3 and grpc-gateway v2.33.0 (openapiv2 options); see `bundle/VERSIONS.md` and `bundle/LICENSES`.
- The `.proto` parser is derived from pbkit 0.0.72 (MIT OR Apache-2.0, used under MIT); see `src/parser/NOTICE`.
