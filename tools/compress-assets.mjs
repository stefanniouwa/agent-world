/**
 * Shrink the runtime glbs for the spectator build.
 *
 * `node tools/compress-assets.mjs <in-dir> <out-dir>` reads every glb the colony loads and
 * writes a meshopt-compressed copy (EXT_meshopt_compression) with its textures cut to 512px.
 * The loaders pick up the matching decoder, so the same code reads either copy.
 *
 * Positions stay float. Quantising them moves a dequantisation scale onto each node, and both
 * `kit.js` (which bakes every node into its own frame) and `crew.js` (which merges the skinned
 * parts without their node transforms) read raw positions, so a quantised kit comes out the
 * wrong size. Normals, UVs, colours and skin weights quantise safely, and the compression does
 * the rest.
 *
 * The output is generated and never committed: see `.gitignore`.
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Logger, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions'
import { dedup, prune, quantize, reorder, resample, textureCompress } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'

export const FILES = ['crew.glb', 'forest.glb', 'nature.glb', 'spacebase.glb']
const TEXTURE_SIZE = 512

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    return null
  }
}

export async function compressAssets(inDir, outDir) {
  await MeshoptEncoder.ready
  await MeshoptDecoder.ready
  const io = new NodeIO()
    .setLogger(new Logger(Logger.Verbosity.WARN))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
  const sharp = await loadSharp()
  mkdirSync(outDir, { recursive: true })

  const report = []
  for (const file of FILES) {
    const src = join(inDir, file)
    const doc = await io.read(src)
    const steps = [
      dedup(),
      resample(),
      prune({ keepAttributes: true, keepLeaves: true }),
      reorder({ encoder: MeshoptEncoder, target: 'size' }),
      quantize({
        pattern: /^(NORMAL|TEXCOORD|JOINTS|WEIGHTS|COLOR)(_\d+)?$/,
        quantizeNormal: 8,
      }),
    ]
    if (sharp) steps.push(textureCompress({ encoder: sharp, resize: [TEXTURE_SIZE, TEXTURE_SIZE], targetFormat: 'png' }))
    await doc.transform(...steps)
    doc
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
    const out = join(outDir, file)
    await io.write(out, doc)
    report.push({ file, before: statSync(src).size, after: statSync(out).size })
  }
  return report
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inDir = 'public/assets', outDir = 'dist-spectator/assets'] = process.argv.slice(2)
  const report = await compressAssets(inDir, outDir)
  let before = 0
  let after = 0
  for (const r of report) {
    before += r.before
    after += r.after
    console.log(`${r.file.padEnd(16)} ${(r.before / 1024).toFixed(0).padStart(6)} KB -> ${(r.after / 1024).toFixed(0).padStart(6)} KB`)
  }
  console.log(`${'total'.padEnd(16)} ${(before / 1024).toFixed(0).padStart(6)} KB -> ${(after / 1024).toFixed(0).padStart(6)} KB`)
}
