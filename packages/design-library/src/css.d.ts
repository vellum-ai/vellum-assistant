// Side-effect CSS imports (e.g. `import "katex/dist/katex.min.css"`) carry no
// types; declare them so tsc accepts the import and emits it for the consumer's
// bundler to resolve.
declare module "*.css";
