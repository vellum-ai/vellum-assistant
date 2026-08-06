# Vellum bundle contract fixtures

`valid.vellum` is generated with JSZip using the format version 2 manifest and
DEFLATE settings from `assistant/src/bundler/app-bundler.ts`. The remaining
archives cover malformed ZIP data, traversal, oversized icons, and missing or
malformed manifests. Native tests consume these committed archives directly so
format drift between TypeScript bundle creation and the Explorer parser fails
before installer integration.
