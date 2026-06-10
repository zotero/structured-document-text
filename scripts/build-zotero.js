import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as esbuild from 'esbuild';

const outfile = 'build/zotero/structured-document-text.cjs';

await mkdir(dirname(outfile), { recursive: true });

await esbuild.build({
	entryPoints: ['src/read.js'],
	bundle: true,
	platform: 'browser',
	target: ['firefox140'],
	format: 'cjs',
	outfile,
});
