# Vellum bundle contract fixtures

`valid.vellum` uses the format version 2 manifest and DEFLATE settings from
`assistant/src/bundler/app-bundler.ts`. The other archives cover malformed ZIP
data, traversal, oversized icons, and missing or malformed manifests. Native
tests consume them directly to detect format drift before installer integration.
