/**
 * Bundle the game into one self-contained HTML file.
 *
 * The playable page is normally a set of ES modules plus a vendored Three.js,
 * which needs a web server. This inlines everything — markup, CSS and a single
 * bundled script — into `dist/ashfall.html`, which runs from a file:// path or
 * anywhere that can host one static file.
 *
 *   node tests/build-single-file.js
 */
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = ROOT + 'dist/ashfall.html';

const bundled = await build({
  entryPoints: [ROOT + 'src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  // the import map is a runtime concept; resolve it at build time instead
  alias: { three: ROOT + 'vendor/three.module.min.js' },
});

const js = bundled.outputFiles[0].text;
const css = await readFile(ROOT + 'src/style.css', 'utf8');
const html = await readFile(ROOT + 'index.html', 'utf8');

// keep everything between <body> and the module script tag
const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('<script type="module"'))
  .trim();
const title = (html.match(/<title>([^<]*)<\/title>/) || [, 'ASHFALL'])[1];
const favicon = (html.match(/<link rel="icon"[^>]*>/) || [''])[0];

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
${favicon}
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${js}
</script>
</body>
</html>
`;

await mkdir(ROOT + 'dist', { recursive: true });
await writeFile(OUT, page);
console.log(`wrote dist/ashfall.html  (${(page.length / 1024).toFixed(0)} KB)`);
