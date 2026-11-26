import { copyFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { apiMiddleware } from './server/api.mjs'

/** Serves /api from inside the Vite dev server, so `npm run dev` is the whole game. */
const api = () => ({
  name: 'bot-crossing-api',
  configureServer(server) {
    server.middlewares.use(apiMiddleware)
  },
})

/**
 * The spectator build's output: `world.html` becomes `index.html`, and the models are
 * compressed into `dist-spectator/assets/` rather than copied as they are. See SPECTATOR.md.
 */
const spectatorOutput = (outDir) => ({
  name: 'agent-world-spectator',
  apply: 'build',
  async writeBundle() {
    renameSync(resolve(outDir, 'world.html'), resolve(outDir, 'index.html'))
    const { compressAssets } = await import('./tools/compress-assets.mjs')
    const report = await compressAssets('public/assets', resolve(outDir, 'assets'))
    for (const r of report) {
      this.info(`${r.file}: ${(r.before / 1024).toFixed(0)} KB -> ${(r.after / 1024).toFixed(0)} KB`)
    }
    copyFileSync('public/assets/CREDITS.md', resolve(outDir, 'assets/CREDITS.md'))
    copyFileSync('LICENSE', resolve(outDir, 'LICENSE.txt'))
  },
})

export default defineConfig(({ mode, command }) => {
  if (mode === 'spectator') {
    const outDir = resolve('dist-spectator')
    return {
      // Relative, so the build runs from whatever folder the site serves it from.
      base: './',
      // The dev server serves the models as they are; the build writes compressed ones itself
      // and leaves out everything else in public/ (sound overrides, the unused HDR).
      publicDir: command === 'serve' ? 'public' : false,
      server: { port: Number(process.env.PORT) || 5276, strictPort: false },
      build: {
        target: 'esnext',
        outDir,
        emptyOutDir: true,
        rollupOptions: { input: resolve('world.html') },
        // three.js is most of it, and it is one page with one job: there is nothing to split off.
        chunkSizeWarningLimit: 1200,
      },
      plugins: [spectatorOutput(outDir)],
    }
  }
  return {
    plugins: [api()],
    // PORT lets a second copy run alongside the first without a flag on the command line.
    server: { port: Number(process.env.PORT) || 5274, strictPort: false },
    build: { target: 'esnext' },
  }
})
