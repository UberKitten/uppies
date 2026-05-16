import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const frontendDir = path.join(root, 'frontend');
const outDir = path.join(frontendDir, 'dist');

fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(frontendDir, 'app.js')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  outfile: path.join(outDir, 'app.js'),
  legalComments: 'none',
});

fs.copyFileSync(path.join(frontendDir, 'styles.css'), path.join(outDir, 'styles.css'));
fs.copyFileSync(path.join(frontendDir, 'index.html'), path.join(outDir, 'index.html'));

console.log('frontend built to', outDir);
