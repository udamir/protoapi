---
layout: page
title: Online demo
description: Convert between .proto files, FileDescriptorSets and ProtoApi documents, in your browser.
---

<script setup>
import ProtoApiDemo from "./.vitepress/theme/components/ProtoApiDemo.vue"
</script>

<div class="demo-page">

# Online demo

Pick what you have and what you want: `.proto` files, a `FileDescriptorSet` (ProtoJSON, as `buf build -o image.json` writes it) or a ProtoApi document (YAML or JSON) on the left; a ProtoApi document, the `.proto` files printed back from it, or the source map on the right. The `.proto` input can hold several files, which import each other by path (double-click a tab to rename a file); imports of the well-known types, googleapis, protovalidate, PGV and grpc-gateway resolve from the [bundled definitions](/guide/imports). The `imports` and `annotations` selectors are the [build options](/guide/usage#build-options) of the same name. Build issues are listed below the editors; click one to jump to its location. The output updates as you type, and the line below the editors shows the `protoapi` call that produced it. **⇄ Use as input** converts the result back, **Share** copies a link to your input. Everything runs in your browser with the current sources; the [conversion examples](/examples/) and the [specification](/spec/v0.1) explain the output.

<ClientOnly>
  <ProtoApiDemo />
</ClientOnly>

</div>

<style>
.demo-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 32px 24px 48px;
}

.demo-page h1 {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 8px;
}

.demo-page > p {
  color: var(--vp-c-text-2);
  margin-bottom: 20px;
}

.demo-page a {
  color: var(--vp-c-brand-1);
  text-decoration: underline;
}
</style>
