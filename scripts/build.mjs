// Bundles the app into a single self-contained HTML file.
//   dist/freeflow.html          a complete page you can open from disk
//   dist/freeflow.fragment.html the same page without <html>/<head>/<body>,
//                               for hosts that supply their own document shell
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

const js = await build({
  entryPoints: [new URL('src/main.js', root).pathname],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  write: false,
});
const css = await read('src/style.css');
const template = await read('src/index.html');
const code = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const fragment = template.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => code);
// In the full page, the title, tab icon, fonts and styles (everything before
// the app itself) go in <head>.
const split = fragment.indexOf('<div class="app">');
const head = fragment.slice(0, split).trim();
const body = fragment.slice(split);
const page = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/freeflow.fragment.html', root), fragment);
await writeFile(new URL('dist/freeflow.html', root), page);
console.log(`Built dist/freeflow.html (${(page.length / 1024).toFixed(0)} KB)`);
