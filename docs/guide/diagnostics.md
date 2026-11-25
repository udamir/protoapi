# Diagnostics

The builders never throw on input problems. They report them as issues and still return the most complete document the input allows, so a tool can show a partly broken API, and a diff of two versions still works when one of them has a mistake.

```ts
interface BuildIssue {
  code: BuildIssueCode
  message: string
  file?: string
  location?: Location // where in the source, as in the source map
  pointer?: JsonPointer // the document node concerned, when there is one
}
```

```ts
const { document, issues } = buildFromProto(sources)
for (const issue of issues) {
  const at = issue.location
    ? `${issue.location.file}:${issue.location.start.line + 1}:${issue.location.start.column + 1}`
    : issue.file
  console.log(`${at}: ${issue.code}: ${issue.message}`)
}
```

The text producer checks the definitions of every file it builds that is not bundled, as buf does: a file buf rejects gives at least one issue. Issues are in no particular order between files.

## Issue codes

| Code                  | Meaning                                                                                                                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syntax`              | The file does not parse. The document keeps the `syntax` and `package` read before the error, and takes no declarations from the file.                                                                                                                                                                                     |
| `missing-import`      | An import is not found in `sources`, the bundle or the loader.                                                                                                                                                                                                                                                             |
| `unresolved-type`     | A type name does not resolve, or resolves to a name of the wrong kind (an enum as an rpc type, a message as a map key, an option name that is not an extension), or to a type not visible from the file (not imported, `local` in edition 2024, imported only with `import option`). The field keeps a best-effort `$ref`. |
| `unresolved-extendee` | The message of an `extend` block does not resolve.                                                                                                                                                                                                                                                                         |
| `unknown-option`      | A custom option without a definition. Its source text is kept as a string under `options`, and nothing is lifted from it. Also a field that a known option message does not have.                                                                                                                                          |
| `invalid-option`      | An option value that does not fit its definition: out of range, an unknown enum value, a non-canonical literal, an option on the wrong target, a protovalidate rule family that does not fit the field, …                                                                                                                  |
| `invalid-number`      | A field or value number out of range or in the reserved range 19000 to 19999; an extension outside the extension ranges of its message.                                                                                                                                                                                    |
| `duplicate-number`    | Two fields or (without `allow_alias`) two enum values with the same number.                                                                                                                                                                                                                                                |
| `duplicate-name`      | Two declarations with the same name, including JSON-name clashes and C++ scoping clashes of enum values.                                                                                                                                                                                                                   |
| `reserved-conflict`   | A field or value uses a reserved number or name; reserved and extension ranges overlap.                                                                                                                                                                                                                                    |
| `annotation-conflict` | Two annotation sources set a keyword to different values; recorded in `x-annotation-conflicts`, see [Annotations](/guide/annotations#precedence-and-conflicts).                                                                                                                                                            |
| `invalid-tag`         | A known comment tag whose value does not parse or that does not fit the field.                                                                                                                                                                                                                                             |
| `unsupported`         | Something this version cannot handle: an unknown edition (written verbatim and resolved with the edition 2026 defaults), a binary set without a usable decoder.                                                                                                                                                            |
| `no-source-info`      | A descriptor-set file without `sourceCodeInfo`: no descriptions and no source map entries for it.                                                                                                                                                                                                                          |
| `invalid-definition`  | A syntax or edition rule is broken: proto3 `required` or groups, editions labels, options or keywords not available in the file's edition, naming style in edition 2024 and later, import cycles, statement order.                                                                                                         |

## Example

```proto
syntax = "proto3";

package demo.broken;

import "missing/thing.proto";

message Broken {
  string id = 1;
  int32 count = 1;
  Unknown ref = 2;
  required string legacy = 3;
  string bad = 4 [(nope.option) = 1];
  // @Minimum lots
  int32 size = 5;

  reserved 6;
  string reused = 6;
}
```

gives these issues (with locations and pointers), and still a document with every field of `Broken`:

```text
invalid-definition  required fields are not allowed in proto3 (legacy)
missing-import      import "missing/thing.proto" not found
duplicate-number    field number 1 is used by id and count
unresolved-type     unresolved type: Unknown is not defined
unknown-option      unknown option nope.option
invalid-tag         invalid comment tag @Minimum lots: a finite decimal number is expected (field size)
reserved-conflict   field reused = 6 uses a reserved number or name
```

See it in the [diagnostics example](/examples/#diagnostics), or paste your own files into the [online demo](/demo), where clicking an issue selects its location.

## Programming errors

Arguments of the wrong type are not input problems but bugs in the calling code, and throw a `TypeError` — synchronously, also for the async builders: sources that are not an object of strings, a descriptor set without a `file` array, bytes that are not a `Uint8Array`, an option of the wrong type, `imports` contradicting the deprecated `includeImports`. The same holds for `printProto`, `parseProto`, `locatePointer` and `locateDiff`. `printProto` prints documents with missing optional parts without throwing.
