import { defineConfig } from "vitepress"

import pkg from "../../package.json" with { type: "json" }
import { CASES } from "./theme/cases"

// the heading ids VitePress gives the example sections, whose titles are the case titles
const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const GUIDE = {
  text: "Guide",
  items: [
    { text: "What is ProtoApi?", link: "/guide/" },
    { text: "Getting started", link: "/guide/getting-started" },
    { text: "Usage", link: "/guide/usage" },
    { text: "Imports and the bundle", link: "/guide/imports" },
    { text: "Annotations", link: "/guide/annotations" },
    { text: "Source maps", link: "/guide/source-maps" },
    { text: "Diagnostics", link: "/guide/diagnostics" },
    { text: "API reference", link: "/guide/api" },
    { text: "Contributing", link: "/guide/contributing" },
  ],
}

const SPECIFICATION = {
  text: "Specification",
  items: [
    { text: "Overview", link: "/spec/" },
    { text: "ProtoApi 0.1", link: "/spec/v0.1" },
  ],
}

const EXAMPLES = {
  text: "Conversion examples",
  collapsed: false,
  items: CASES.map((item) => ({ text: item.title, link: `/examples/#${slug(item.title)}` })),
}

const TOOLS = {
  text: "Tools",
  items: [
    { text: "Online demo", link: "/demo" },
    { text: "Conversion examples", link: "/examples/" },
    { text: "API reference", link: "/guide/api" },
  ],
}

export default defineConfig({
  title: "ProtoApi",
  description:
    "ProtoApi — a JSON document format for Protocol Buffers and gRPC APIs, with builders from .proto text and FileDescriptorSets, a printer and a source map",
  // served from https://udamir.github.io/protoapi/
  base: "/protoapi/",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/protoapi/logo.svg" }]],
  vite: {
    build: {
      // the examples page embeds pre-highlighted output of every example, the demo the bundled .proto sources
      chunkSizeWarningLimit: 2400,
    },
  },
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "/guide/" },
      { text: "Specification", link: "/spec/", activeMatch: "/spec/" },
      { text: "Examples", link: "/examples/", activeMatch: "/examples/" },
      { text: "API", link: "/guide/api" },
      { text: "Demo", link: "/demo" },
      {
        text: `v${pkg.version}`,
        items: [
          { text: "Changelog", link: "/changelog" },
          { text: "npm", link: "https://www.npmjs.com/package/protoapi" },
          { text: "api-smart-diff", link: "https://github.com/udamir/api-smart-diff" },
          { text: "GraphAPI", link: "https://udamir.github.io/graphapi/" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [GUIDE, SPECIFICATION, TOOLS],
      "/spec/": [SPECIFICATION, EXAMPLES, TOOLS],
      "/examples/": [EXAMPLES, SPECIFICATION, TOOLS],
    },
    outline: { level: [2, 3] },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/udamir/protoapi" }],
    editLink: {
      pattern: "https://github.com/udamir/protoapi/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Damir Yusipov",
    },
  },
})
