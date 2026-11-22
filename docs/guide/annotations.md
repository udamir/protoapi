# Annotations

Protobuf has no built-in way to say that a string is an e-mail address, that a number is at least 1 or that a field must be set by the client. APIs say it anyway, in several competing conventions: comment tags, the [AIP](https://google.aip.dev/203) comment prefixes and `google.api.field_behavior`, [protovalidate](https://protovalidate.com) and the older [protoc-gen-validate](https://github.com/bufbuild/protoc-gen-validate) (PGV) rules, and [grpc-gateway](https://github.com/grpc-ecosystem/grpc-gateway)'s OpenAPI options.

The annotation layer of `protoapi` reads all of them and writes the result as one vocabulary — the JSON Schema keywords `required`, `minimum`, `maxLength`, `pattern`, `format`, `enum`, `readOnly`, … — on the field (or on its `items`, map key or map value). A consumer reads one set of keywords, whatever convention the API uses, and a diff tool sees that `(buf.validate.field).string.max_len = 64` and `// @MaxLength 64` mean the same thing.

```proto
message Signup {
  // Required. The user's e-mail address.
  string email = 1 [(buf.validate.field).string.email = true];
  // @MaxLength 64
  string name = 2;
  int32 age = 3 [(buf.validate.field).int32 = { gt: 0, lte: 150 }];
}
```

```yaml
email: { description: The user's e-mail address., number: 1, type: string, protoType: string, required: true, format: email }
name: { number: 2, type: string, protoType: string, maxLength: 64 }
age: { number: 3, type: integer, protoType: int32, maximum: 150, exclusiveMinimum: 0 }
```

A lifted option is removed from `options`, a lifted tag or prefix from the description. Whatever cannot be expressed as a keyword — CEL expressions, `ignore`, message-level rules — stays under `options`, typed.

::: info Requiredness
`required: true` on a field is **annotation-level** requiredness: the API says the field must be set. **Wire-level** requiredness — a proto2 `required` label or editions `LEGACY_REQUIRED` — is `presence: required` and never sets the keyword. Messages carry no JSON Schema `required` array.
:::

## Comment tags

A tag is a line of a field's leading or trailing comment that starts with `@` and a known tag name (case-insensitive, optional colon). The line is removed from the description.

| Tag | Keyword | Value |
| --- | --- | --- |
| `@Required` | `required: true` | none, `true` or `false` |
| `@Min` / `@Minimum`, `@Max` / `@Maximum` | `minimum`, `maximum` | a decimal number; on 64-bit fields an integer, written as a decimal string |
| `@ExclusiveMinimum`, `@ExclusiveMaximum`, `@MultipleOf` | same names | as `@Minimum` |
| `@MinLength`, `@MaxLength`, `@MinItems`, `@MaxItems` | same names | a non-negative integer |
| `@Pattern` | `pattern` | the rest of the line |
| `@Format` | `format` | a name (`email`, `uuid`, `uri`, …); string fields only |
| `@Enum` | `enum` | comma-separated values; strings on string fields, protobuf constants on numeric and enum fields |
| `@Default` | `x-default` | JSON if it parses, else the raw string |
| `@Example` (repeatable) | `examples` | JSON if it parses, else the raw string |
| `@ReadOnly`, `@WriteOnly` | `readOnly`, `writeOnly` | none, `true` or `false` |
| `@Deprecated` | `deprecation.reason` | the rest of the line; sets `deprecation` without the option |
| `@Title` | `title` | the rest of the line |

On a repeated field, value tags (`@Minimum`, `@Pattern`, `@Format`, `@Enum`, lengths) apply to `items`, and `@MinItems` / `@MaxItems` to the field. On a map field, value tags apply to the map value and `@MinItems` / `@MaxItems` become `minProperties` / `maxProperties`. Wrapper types (`google.protobuf.StringValue`, `Int64Value`, …) take the tags of their scalar. Any other `@tag` stays in the description.

A known tag whose value does not parse, or that does not fit the field (`@Format` on an integer), is removed from the description too and gives an `invalid-tag` [issue](/guide/diagnostics). See the [comment tags example](/examples/#comment-tags).

### Renaming and disabling tags

If your API uses other tag names, or uses a tag name for something else, rename or disable tags with the `tags` build option:

```ts
buildFromProto(sources, { tags: { default: "DefaultValue", example: false } })
// // @DefaultValue 10   -> x-default: 10
// // @Example foo       -> stays in the description
```

Pass the same map to `printProto` so that printed tags use your names.

## AIP prefixes

The [AIP](https://google.aip.dev/203) convention starts a field comment with a field behaviour. `protoapi` recognizes these prefixes, with exact casing, at the start of the first line of the description:

| Prefix | Keyword |
| --- | --- |
| `Required.` | `required: true` |
| `Output only.` | `readOnly: true` |
| `Input only.` | `writeOnly: true` |
| `Immutable.` | `immutable: true` |
| `Identifier.` | `IDENTIFIER` added to `options["google.api.field_behavior"]` |
| `Optional.` | nothing (removed from the description) |

Prefixes stack (`Required. Immutable. The id.`). On every element kind, a first line `Deprecated: <reason>` sets `deprecation.reason`. Prefixes and the `Deprecated:` line are removed from the description.

## Convention options

Options are lifted when their definition is known — bundled, or present in the input — which is the case for every convention below without any setup.

**`google.api`** — `(google.api.field_behavior)` `REQUIRED`, `OUTPUT_ONLY`, `INPUT_ONLY` and `IMMUTABLE` give `required`, `readOnly`, `writeOnly` and `immutable`; `OPTIONAL`, `IDENTIFIER`, `UNORDERED_LIST` and `NON_EMPTY_DEFAULT` stay under `options`. `(google.api.field_info).format` `UUID4`, `IPV4`, `IPV6` and `IPV4_OR_IPV6` give `format: uuid`, `ipv4`, `ipv6` and `ip`. `(google.api.http)` on a method becomes the method's `http` rule. See the [AIP example](/examples/#aip-prefixes-and-google-api-field-options).

**protovalidate** — `(buf.validate.field)`:

| Rule | Keyword |
| --- | --- |
| `required` | `required: true` |
| numeric `gt`, `gte`, `lt`, `lte`, `const`, `in` | `exclusiveMinimum`, `minimum`, `exclusiveMaximum`, `maximum`, `const`, `enum` |
| `string.min_len`, `max_len`, `len`, `pattern`, `prefix`, `suffix`, `contains`, `const`, `in` | `minLength`, `maxLength`, both, `pattern`, `pattern` (`^` + escaped), `pattern` (escaped + `$`), `pattern` (escaped), `const`, `enum` |
| `string.email`, `hostname`, `ip`, `ipv4`, `ipv6`, `uri`, `uri_ref`, `uuid`, … | `format` with the same name (`uri_ref` → `uri-reference`) |
| `bytes.min_len`, `max_len`, `len`, `const`, `in` | `minLength`, `maxLength`, both, `const` (base64), `enum` |
| `bool.const`, `enum.const`, `enum.in` | `const`, `enum` (enum value names) |
| `repeated.min_items`, `max_items`, `unique`, `items` | `minItems`, `maxItems`, `uniqueItems`, rules on `items` |
| `map.min_pairs`, `max_pairs`, `keys`, `values` | `minProperties`, `maxProperties`, rules on `propertyNames` / `additionalProperties` |
| `<type>.example` | `examples` |
| `cel`, `ignore`, `not_in`, `enum.defined_only`, timestamp / duration / any rules, `(buf.validate.message)`, `(buf.validate.oneof)` | stay under `options` |

See the [protovalidate example](/examples/#protovalidate-rules).

**protoc-gen-validate** — `(validate.rules)` maps the same way with PGV's names; `message.required` gives `required: true`.

**grpc-gateway** — `openapiv2_field` gives `title`, `examples`, `pattern`, `format`, bounds, lengths, `uniqueItems`, `multipleOf`, `enum`, `readOnly` and `x-default` (its `description` is ignored: comments win); `openapiv2_schema.json_schema.required` gives `required: true` on each named field and `json_schema.title` the message `title`; `openapiv2_operation.deprecated` gives the method's `deprecation`. See the [PGV and grpc-gateway example](/examples/#legacy-pgv-and-grpc-gateway).

A rule family that does not fit the field — `(buf.validate.field).string` on an integer, say — is an `invalid-option` issue, and the family stays raw under `options`.

## Precedence and conflicts

When several sources set the same keyword, the first in this order wins:

1. built-in options (`deprecated`, `json_name`, `default`)
2. `google.api.*`
3. protovalidate (`buf.validate`)
4. protoc-gen-validate (`validate.rules`)
5. grpc-gateway (`openapiv2_*`)
6. comment tags and AIP prefixes

Equal values are not a conflict. Different values are: the higher source is kept, and the element records the conflict in `x-annotation-conflicts`, with one `annotation-conflict` issue for each:

```proto
message Coupon {
  // @MaxLength 100
  // @Required
  string code = 1 [(buf.validate.field).string.max_len = 64, (google.api.field_behavior) = OPTIONAL];
}
```

```yaml
code:
  number: 1
  type: string
  protoType: string
  maxLength: 64
  options:
    google.api.field_behavior: [OPTIONAL]
  x-annotation-conflicts:
    - { keyword: maxLength, kept: { source: buf.validate, value: 64 }, dropped: { source: tag, value: 100 } }
    - { keyword: required, kept: { source: google.api, value: false }, dropped: { source: tag, value: true } }
```

`OPTIONAL` counts as "not required", so it beats the `@Required` tag. After [printing](/guide/usage#print-a-document-back-to-proto), only the kept value is left, so `x-annotation-conflicts` is the one part of a document a round trip does not keep. See the [conflicts example](/examples/#precedence-and-conflicts).

## Turning the layer off

The `annotations` build option chooses what is lifted:

| `annotations` | Lifted |
| --- | --- |
| `"all"` (default) | comment tags, AIP prefixes and convention options |
| `"options"` | convention options only; comments are kept verbatim as descriptions |
| `"none"` | nothing: every convention option stays under `options` raw, comments are descriptions |

The built-in keywords (`deprecation` from `[deprecated = true]`, `jsonName`, `default`, `idempotency`) and the `http` rule of a method are written in every mode. Print documents built with `"options"` or `"none"` with `printProto(document, { tags: false })`, so that the printer does not turn keywords into comment tags. Try the modes in the [online demo](/demo).
