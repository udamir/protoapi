---
title: Conversion examples
outline: 2
---

<script setup>
import ConversionExample from "../.vitepress/theme/components/ConversionExample.vue"
</script>

# Conversion examples

Each example below is a set of `.proto` files shown in every form `protoapi` works with: the `.proto` source, the ProtoApi document built from it, the `FileDescriptorSet` buf compiles from the same files, the source map, and the `.proto` text printed back from the document. Switch the tabs to compare them. All outputs are generated from the current sources when the site is built, so they are exactly what the library produces. **Open in demo** loads the files into the [online demo](/demo), where you can edit them.

The badges state three facts that are checked for every example: whether building the printed files gives the same document again (a lossless round trip), whether the document built from buf's descriptor set with `buildFromDescriptorSet` equals the one built from the text, and whether the build reported [issues](/guide/diagnostics). **Specification** links to the section of the [ProtoApi 0.1 specification](/spec/v0.1) that defines the mapping.

::: tip How to read the ProtoApi tab
The [specification](/spec/v0.1) defines every key. As a rule of thumb: services and components are keyed by fully qualified name and name their `file`; every field has its `number` and one type shape — `type` + `protoType` for scalars, `$ref` for messages and enums, `type: array` + `items`, or `type: object` + `propertyNames` + `additionalProperties` for maps; protobuf keywords (`presence`, `oneof`, `jsonName`, …) appear only when they differ from the default; and options that are not lifted into a keyword stay under `options`, typed.
:::

## Pet shop

A small but complete API: a file header, a service with an HTTP binding and an idempotency level, a message with scalar, optional, repeated, map, oneof and enum fields, nested messages, reserved numbers and names, a `json_name`, and annotations from three sources — the `Required.` AIP prefix, `@Format` / `@MaxLength` / `@Maximum` comment tags and `google.api.field_behavior`. The trailing comment of `nickname` is its description, and the `google/api` imports contribute nothing to the document but their option definitions.

<ConversionExample id="pet-shop" />

## Scalar fields

Every scalar position carries both a JSON Schema `type` and the protobuf `protoType`: the 32- and 64-bit integer types are `integer`, `float` and `double` are `number`, `bool` is `boolean`, and `string` and `bytes` are `string`. A consumer reads the wire type from `protoType` and never has to infer it.

<ConversionExample id="scalars" />

## Cardinality and presence

`presence: explicit` is written only on singular scalar and enum fields with explicit presence, such as proto3 `optional`; implicit presence writes nothing. Message fields always track presence, so `optional Address work` gives the same field as `Address home`. Repeated fields are `type: array` with their element type in `items`; `[packed = false]` on a numeric repeated field gives `packed: false`, while `packed = true` is the proto3 default and writes nothing.

<ConversionExample id="presence" />

## Maps

A map field is `type: object`, with its key type in `propertyNames` (an integral, bool or string scalar) and its value type in `additionalProperties` (a scalar or a `$ref`). The synthetic `*Entry` message that descriptors carry for every map is folded back and never appears in the document.

<ConversionExample id="maps" />

## Oneofs

Members of a oneof are ordinary fields of the message with `oneof: <name>`; the oneof itself is listed in `oneofs`, with its description. A `Deprecated:` first line deprecates any element, here a oneof member. The synthetic oneof protoc creates for a proto3 `optional` field is not listed: the field just has `presence: explicit`.

<ConversionExample id="oneofs" />

## Nested types and name resolution

Nested messages and enums are components keyed by their fully qualified name (`demo.nested.Order.Line.Price`), not nested objects. Type references are resolved as protoc resolves them — relative names from the inner scope outwards, fully qualified names with a leading dot — and written as `$ref`s to the resolved component.

<ConversionExample id="nested" />

## proto2: defaults, required and groups

proto2 `required` is wire-level requiredness, `presence: required`; `optional` scalars and enums have `presence: explicit`. Defaults are canonical: a 64-bit default is a decimal string, `inf` is `"Infinity"`, bytes are base64, an enum default is the value name. The group `Shipping` is a field `shipping` with `delimited: true` and a component for its message. The proto2 feature defaults show up as resolved keywords: `packed: false` on the unpacked repeated field, `utf8Validation: false` on strings, `jsonFormat: LEGACY_BEST_EFFORT` on messages and enums, and `closed: true` on the enum. The extension is a component with its `extendee`.

<ConversionExample id="proto2" />

## Enums

An enum is `type: string` with its `values` keyed by name, each with its `number`, in declaration order. Aliases (`allow_alias`) are two names with one number. Reserved numbers are sorted, merged intervals, reserved names a sorted list. Enum fields are `$ref`s to the enum component, also inside `items`.

<ConversionExample id="enums" />

## Reserved numbers, names and extension ranges

`reserved` and `extensions` are written as sorted, merged, inclusive intervals, so `reserved 2, 3, 4 to 6` and `reserved 2 to 6` give the same document; `max` would be 536870911. Options of an extension range other than `declaration`, such as `verification`, are kept per declared range in `extensionOptions`.

<ConversionExample id="reserved" />

## Extensions and custom options

Custom options are extensions of the descriptor option messages, and their definitions are ordinary `components.extensions`. Option values are typed by those definitions: an aggregate value becomes an object with the fields of `Audit`, in its declaration order, and a sub-field assignment `(acme.options.audit).owner = "profile"` becomes the same object shape. Custom options are keyed by their fully qualified name without parentheses.

<ConversionExample id="extensions" />

## Built-in options

Built-in options use their descriptor field names. Options equal to their default (`optimize_for = SPEED`, `[packed = true]` in proto3) are not written; a `json_name` equal to the default JSON name is not written either. `deprecated = true` becomes `deprecation` on every element but the file, where it stays under `options`. Everything else (`jstype`, `ctype`, `debug_redact`, the Java options) stays under `options`.

<ConversionExample id="builtin-options" />

## Services and methods

Methods are keyed by name inside their service, with the request and response types as `$ref`s and `stream: true` for each streaming side — client, server or bidirectional. `idempotency_level` is `idempotency`, and `google.api.http` is normalized into `http`: the verb as `method` (a `custom` pattern gives its kind), the `path`, `body` and `additionalBindings`.

<ConversionExample id="services" />

## Well-known types

Well-known types are ordinary components: a field of type `google.protobuf.Duration` is a `$ref` to `components.messages["google.protobuf.Duration"]`, emitted because it is referenced, with its fields and documentation. The bundled files that declare them are marked `bundled: true` in `files` and are not printed back.

<ConversionExample id="well-known-types" />

## Comments and descriptions

Comments are attached as buf attaches them: the comment block directly above an element leads it, a comment after it on the same line trails it, and the description is both together. Block comments lose their `*` margins, runs of spaces collapse, and blank lines inside a comment are kept. A comment separated from the element by a blank line is detached and ignored — except at the top of the file, where it is the file's `description`.

<ConversionExample id="comments" />

## Comment tags

Comment tags such as `@Pattern`, `@Minimum`, `@Format`, `@Enum` or `@Deprecated` set JSON Schema keywords and are removed from the description. On a repeated field the value tags apply to `items` and `@MinItems` / `@MaxItems` to the array. A 64-bit bound is a decimal string; `@Default` gives `x-default`, `@Example` an entry of `examples`. An unknown `@word` stays in the description. See [Annotations](/guide/annotations#comment-tags).

<ConversionExample id="comment-tags" />

## AIP prefixes and google.api field options

The [AIP](https://google.aip.dev/203) field behaviours are read from both spellings: the comment prefixes `Required.`, `Output only.`, `Input only.`, `Immutable.` and `Identifier.`, and the `google.api.field_behavior` option. They give `required`, `readOnly`, `writeOnly` and `immutable`; behaviours without a keyword (`IDENTIFIER`, `OPTIONAL`, `UNORDERED_LIST`) stay under `options`. `google.api.field_info` formats become `format`.

<ConversionExample id="aip" />

## protovalidate rules

[protovalidate](https://protovalidate.com) rules are lifted into JSON Schema keywords: numeric bounds, string lengths, patterns (`prefix` becomes an anchored `pattern`), well-known formats, `in` lists, `const`, repeated and map rules on the array or on `items`, `propertyNames` and `additionalProperties`. CEL rules and message-level rules have no keyword and stay under `options`, typed. A 64-bit bound (`ref`) is a decimal string.

<ConversionExample id="protovalidate" />

## Legacy PGV and grpc-gateway

protoc-gen-validate rules (`validate.rules`) map like protovalidate's. grpc-gateway's `openapiv2_schema` gives the message `title` and `required: true` on each field it names; `openapiv2_field` gives the field `title`, `examples`, lengths and `readOnly`.

<ConversionExample id="pgv-openapiv2" />

## Precedence and conflicts

When sources disagree, the higher one wins — options before comment tags, `google.api` before protovalidate — and the conflict is recorded in `x-annotation-conflicts` on the element, with an `annotation-conflict` issue. `(google.api.field_behavior) = OPTIONAL` counts as "not required", so it beats `@Required`. Equal values (`note`) are not a conflict. The round trip keeps the winning values only, so the printed files build to the same document without `x-annotation-conflicts`.

<ConversionExample id="conflicts" />

## Editions 2023

Editions features are resolved — field, message, file, then the edition default — and written as the same keywords proto2 and proto3 use: the file-wide `field_presence = IMPLICIT` makes `count` implicit, `LEGACY_REQUIRED` is `presence: required`, `EXPLICIT` is `presence: explicit`, `EXPANDED` is `packed: false`, `utf8_validation = NONE` is `utf8Validation: false`, `DELIMITED` is `delimited: true`, `CLOSED` is `closed: true`, and `json_format` is `jsonFormat`. The lifted features are removed from the field's `options`; the file feature that sets an inherited default stays under the file's `options.features`.

<ConversionExample id="editions" />

## Edition 2024: visibility and option imports

Edition 2024's `export` and `local` keywords are kept as `options.visibility`; a type without a keyword (`Plain`) carries nothing. `import option` is recorded in `importFlags`, and the definitions of such a file may be used in option names only. With the default `imports: "user"`, the imported user file is emitted in full, so the option definition `acme.opts.table` is in the document.

<ConversionExample id="edition-2024" />

## Imports and bundled files

Only `shop/v1/api.proto` is an entry file here (`entry: ["shop/v1/api.proto"]`). With the default `imports: "user"`, the user files it reaches — `types.proto` and, through `import public`, `money.proto` — are emitted in full, `Unused` included, while the bundled `empty.proto` contributes only `google.protobuf.Empty` and is marked `bundled: true`. Try `imports: "referenced"` in the demo to drop `Unused`. Files are listed with their imports first. See [Imports and the bundle](/guide/imports).

<ConversionExample id="imports" />

## Diagnostics

Invalid input still gives a document: every field of `Broken` is there, `ref` with a best-effort `$ref`, `bad` with its unknown option kept as source text. Each problem is an issue with a code, a message, a location and a pointer — see the **Issues** tab. buf rejects this input, so there is no descriptor set to compare with. See [Diagnostics](/guide/diagnostics).

<ConversionExample id="diagnostics" />
