import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Claude Code loads a mod's own files only as .mjs under hooks/, so the compiled
// mod and core are copied there with their import specifiers rewritten.
const out = 'hooks/lib'
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'core'), { recursive: true })
const copy = (from, to) => writeFileSync(to, readFileSync(from, 'utf8').replace(/(from '\.{1,2}\/[^']+)\.js'/g, "$1.mjs'"))
copy('dist/cc-mod.js', join(out, 'cc-mod.mjs'))
for (const file of readdirSync('dist/core')) copy(join('dist/core', file), join(out, 'core', file.replace(/\.js$/, '.mjs')))
