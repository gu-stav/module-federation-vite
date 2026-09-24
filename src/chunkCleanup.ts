import { readFileSync, writeFileSync } from 'fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { isOutputChunk, type Bundle } from './utils/bundleHelpers';
import {
  isFederationControlChunk,
  sanitizeFederationControlChunk,
} from './utils/controlChunkSanitizer';

export function createChunkCleanup(filename: string) {
  const cleaned = new Map<string, { input: string; output: string }>();
  const cleanCode = (code: string, fileName: string) => {
    const previous = cleaned.get(fileName);
    if (previous?.input === code) return previous.output;
    const output = sanitizeFederationControlChunk(code, fileName, filename);
    cleaned.set(fileName, { input: code, output });
    return output;
  };

  return {
    cleanBundle(bundle: Bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!isOutputChunk(chunk) || !isFederationControlChunk(fileName, filename)) continue;
        chunk.code = cleanCode(chunk.code, fileName);
      }
    },
    plugin: {
      name: 'module-federation-strip-empty-preload-helper',
      enforce: 'post',
      apply: 'build',
      renderChunk(code: string, chunk: { fileName: string }) {
        if (!isFederationControlChunk(chunk.fileName, filename)) return;
        const nextCode = cleanCode(code, chunk.fileName);
        return nextCode === code ? null : { code: nextCode, map: null };
      },
      writeBundle(outputOptions: { dir?: string }, bundle: Bundle) {
        if (!outputOptions.dir) return;
        // Later plugins can change emitted files. Read the final contents even
        // when an earlier hook has already cleaned the in-memory chunk.
        for (const chunk of Object.values(bundle)) {
          if (!isOutputChunk(chunk) || !isFederationControlChunk(chunk.fileName, filename))
            continue;
          const outputPath = path.join(outputOptions.dir, chunk.fileName);
          const code = readFileSync(outputPath, 'utf8');
          const nextCode = cleanCode(code, chunk.fileName);
          if (nextCode !== code) writeFileSync(outputPath, nextCode);
        }
        cleaned.clear();
      },
    } satisfies Plugin,
  };
}
