// Test-only stub for the `server-only` import guard. Next.js's real
// `server-only` package throws on import outside its RSC bundler; under
// vitest (no bundler, no client/server split) that throw would make any
// `web/lib` module doing real server work (e.g. vault.ts) untestable. Aliased
// in vitest.config.ts ONLY for the test run — production builds still get the
// real `server-only` guard via Next's bundler.
export {}
