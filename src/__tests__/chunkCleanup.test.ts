import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFileSync as writeOutput } from 'fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createChunkCleanup } from '../chunkCleanup';
import type { Bundle } from '../utils/bundleHelpers';

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});

function createOutput(code: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'chunk-cleanup-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const fileName = 'remoteEntry.js';
  const file = path.join(dir, fileName);
  const bundle: Bundle = { [fileName]: { type: 'chunk', fileName, code } };
  writeFileSync(file, code);
  vi.mocked(writeOutput).mockClear();
  return { dir, file, fileName, bundle };
}

it('does not write emitted files when cleanup leaves their contents unchanged', () => {
  const output = createOutput('export const value = 1;');
  createChunkCleanup(output.fileName).plugin.writeBundle({ dir: output.dir }, output.bundle);
  expect(readFileSync(output.file, 'utf8')).toBe('export const value = 1;');
  expect(writeOutput).not.toHaveBeenCalled();
});

it('keeps changes made by later plugins when cleaning the emitted file', () => {
  const output = createOutput('export const value = 1;');
  const cleanup = createChunkCleanup(output.fileName);
  cleanup.cleanBundle(output.bundle);
  writeFileSync(
    output.file,
    'export const value = 1; import "./__loadShare__late.js"; export const late = 2;'
  );
  vi.mocked(writeOutput).mockClear();
  cleanup.plugin.writeBundle({ dir: output.dir }, output.bundle);
  expect(readFileSync(output.file, 'utf8')).toBe('export const value = 1;  export const late = 2;');
  expect(writeOutput).toHaveBeenCalledTimes(1);
});

it('still runs the next cleanup pass when earlier output needs more cleanup', () => {
  const cleanup = createChunkCleanup('remoteEntry.js');
  const first = cleanup.plugin.renderChunk(
    'import {_ as x} from "./helper.js";import {_ as y} from "./x.js";',
    { fileName: 'remoteEntry.js' }
  );
  expect(first?.code).toBe('import {_ as x} from "./helper.js";');
  const bundle: Bundle = {
    'remoteEntry.js': { type: 'chunk', fileName: 'remoteEntry.js', code: first?.code ?? '' },
  };
  cleanup.cleanBundle(bundle);
  expect(bundle['remoteEntry.js']).toMatchObject({ code: '' });
});
