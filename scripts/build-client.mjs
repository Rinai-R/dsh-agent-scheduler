// Bundle the browser half into the closure form DSH's client module loader expects.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

// The UI primitives are shared by the client module loader (see src/dsh/client/brand.ts).
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives']
const out = await build({
  entryPoints: ['src/client/index.tsx'], bundle: true, write: false, format: 'cjs', platform: 'browser',
  target: 'es2022', jsx: 'automatic', external, minify: false, charset: 'utf8',
})
const body = out.outputFiles[0].text
mkdirSync('dist', { recursive: true })
writeFileSync('dist/client.js', `window.__ModuleLoader__.load({
  id: "dsh-agent-scheduler",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
${body}
    return module.exports;
  }
});
`)
