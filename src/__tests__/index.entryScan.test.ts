import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync, statSync } from 'fs';
import type { ConfigPluginContext, Plugin } from 'vite';
import { expect, it, onTestFinished, vi } from 'vitest';
import { federation } from '../index';
import { callHook } from '../utils/__tests__/viteHookHelpers';
import type { NormalizedModuleFederationOptions } from '../utils/normalizeModuleFederationOptions';
import { getPreloadRemotes } from '../virtualModules/virtualRemotes';

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, statSync: vi.fn(fs.statSync), readFileSync: vi.fn(fs.readFileSync) };
});

function createEntryScan(files: Record<string, string>, exposes: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'entry-scan-test-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), '{}');
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), code);
  }
  const plugins = federation({
    name: path.basename(root),
    remotes: { remote: 'remote@http://localhost:5001/remoteEntry.js' },
    exposes,
  }) as Plugin[];
  const entryScanPlugin = plugins.find(
    (plugin) => plugin.name === 'vite:module-federation-early-init'
  )!;
  const mainPlugin = plugins.find(
    (plugin) => plugin.name === 'module-federation-vite'
  ) as Plugin & {
    _options: NormalizedModuleFederationOptions;
  };
  return {
    root,
    run() {
      vi.mocked(statSync).mockClear();
      vi.mocked(readFileSync).mockClear();
      callHook(
        entryScanPlugin.config,
        { meta: {} } as ConfigPluginContext,
        {
          root,
          build: { rollupOptions: { input: 'src/main.ts' } },
        },
        { command: 'build', mode: 'test' }
      );
      const getSourceFileCalls = (calls: unknown[][]) =>
        calls
          .map(([file]) => String(file))
          .filter((file) => file.startsWith(path.join(root, 'src') + path.sep));
      return {
        preloadedRemotes: getPreloadRemotes(mainPlugin._options),
        fileChecks: getSourceFileCalls(vi.mocked(statSync).mock.calls),
        sourceReads: getSourceFileCalls(vi.mocked(readFileSync).mock.calls),
      };
    },
  };
}

it('preloads statically imported remotes without reading the same file twice', () => {
  const entryScan = createEntryScan(
    {
      'src/main.ts': 'import "./left"; import "./right"; import("./lazy");',
      'src/left.ts': 'import "./common"; import "./missing";',
      'src/right.ts': 'import "./common"; import "./missing";',
      'src/common/index.ts':
        'import "../left"; import "remote/static"; import type { T } from "remote/type";',
      'src/lazy.ts': 'import "remote/lazy";',
    },
    { './exposed': './src/left.ts' }
  );
  const result = entryScan.run();
  expect(result.preloadedRemotes).toEqual(new Set(['remote/static']));
  expect(result.sourceReads).toHaveLength(new Set(result.sourceReads).size);
  const missingFileChecks = result.fileChecks.filter((file) => file.includes(`${path.sep}missing`));
  expect(missingFileChecks.length).toBeGreaterThan(0);
  expect(missingFileChecks).toHaveLength(new Set(missingFileChecks).size);
  expect(
    result.fileChecks.filter((file) => file === path.join(entryScan.root, 'src/common'))
  ).toHaveLength(1);
});

it('finds updated imports and newly created modules when the config hook runs again', () => {
  const entryScan = createEntryScan({
    'src/main.ts': 'import "./missing"; import "./existing";',
    'src/existing.ts': 'export {};',
  });
  expect(entryScan.run().preloadedRemotes.size).toBe(0);
  writeFileSync(path.join(entryScan.root, 'src/missing.ts'), 'import "remote/added";');
  writeFileSync(path.join(entryScan.root, 'src/existing.ts'), 'import "remote/changed";');
  expect(entryScan.run().preloadedRemotes).toEqual(new Set(['remote/added', 'remote/changed']));
});

it('resolves relative imports and checks files before directory index files', () => {
  const entryScan = createEntryScan({
    'src/main.ts': 'import "./a/entry"; import "./b/entry";',
    'src/a/entry.ts': 'import "./dep?version=1";',
    'src/b/entry.ts': 'import "./dep#fragment";',
    'src/a/dep.js': 'import "remote/a-js";',
    'src/a/dep.ts': 'import "remote/a-ts";',
    'src/a/dep/index.js': 'import "remote/a-directory";',
    'src/b/dep/index.ts': 'import "remote/b-directory";',
  });
  expect(entryScan.run().preloadedRemotes).toEqual(new Set(['remote/a-js', 'remote/b-directory']));
});
