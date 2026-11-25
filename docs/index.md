---
layout: home

hero:
  name: ProtoApi
  text: Protocol Buffers APIs as JSON
  tagline: A readable, diffable JSON document for .proto files — build it from .proto text or a FileDescriptorSet, locate every node in the source, and print it back to .proto.
  image:
    src: /logo.svg
    alt: ProtoApi
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Read the specification
      link: /spec/
    - theme: alt
      text: Try the online demo
      link: /demo

features:
  - icon: 📐
    title: One document for the whole API
    details: Services and methods on top; messages, enums and extensions as components keyed by fully qualified name; fields with JSON Schema vocabulary and protobuf keywords where the semantics differ.
    link: /spec/
    linkText: Specification
  - icon: 🔁
    title: Two producers, byte-identical output
    details: A pure TypeScript .proto parser and a FileDescriptorSet reader (buf images, ProtoJSON or binary) give the same document, checked against buf for every example.
    link: /examples/
    linkText: Conversion examples
  - icon: 🖨️
    title: Lossless round trips
    details: printProto turns a document back into .proto text, and building the printed files gives the same document — options, comments, groups, editions features and lifted annotations included.
    link: /guide/usage#print-a-document-back-to-proto
    linkText: Printing
  - icon: 🏷️
    title: Annotation layer
    details: Comment tags, AIP prefixes, google.api field behaviour, protovalidate, protoc-gen-validate and grpc-gateway rules are lifted into one set of JSON Schema keywords, with conflicts recorded.
    link: /guide/annotations
    linkText: Annotations
  - icon: 📍
    title: Source maps
    details: Every node of the document is located in the original files, down to the token of a field number or the line of a comment tag — the same spans from both producers.
    link: /guide/source-maps
    linkText: Source maps
  - icon: 🧩
    title: proto2, proto3 and editions
    details: Editions 2023, 2024 and 2026 with feature resolution from descriptor.proto, bundled well-known types and googleapis, protovalidate, PGV and grpc-gateway definitions. No runtime dependencies, Node.js and browser.
    link: /guide/imports
    linkText: Imports and the bundle
---
