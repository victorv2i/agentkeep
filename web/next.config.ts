import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Allow an isolated build/dev output dir (e.g. `AK_DISTDIR=.next-ui`) so a dev
  // server or a verification build never clobbers the `.next` that a running
  // `next start` (the deployed app) is serving. Defaults to the standard `.next`.
  distDir: process.env.AK_DISTDIR ?? '.next',

  // The core is consumed as COMPILED JS: its package `exports` resolves to
  // `dist/core/index.js` (built by `tsc`), with `src/core/index.ts` as the
  // type source. So Next does not need to transpile TS here — it just imports
  // a normal ESM package. (We build the core before the web app; see the
  // workspace `dev`/`build` wiring.)
  //
  // The core is a server-only Node library (fs + git via simple-git, chokidar,
  // etc.). It is imported only from server modules guarded by `import
  // 'server-only'`. We also keep the core + its native-ish deps external so
  // they are bundled by Node at runtime, never pulled into a client bundle.
  serverExternalPackages: [
    '@agentkeep/core',
    'simple-git',
    'chokidar',
    'write-file-atomic',
  ],

  // The vault IS the app: the editor that used to live at /notes is the home
  // page now. Old links keep working (query params carry over by default).
  async redirects() {
    return [{ source: '/notes', destination: '/', permanent: false }]
  },
}

export default nextConfig
