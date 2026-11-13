/** Bundle the web app (viem included) into public/js so nothing is loaded from a CDN at runtime. */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  absWorkingDir: root,
  entryPoints: { app: 'web/app.ts', report: 'web/report.ts' },
  outdir: 'public/js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  legalComments: 'linked',
  logLevel: 'info',
});
