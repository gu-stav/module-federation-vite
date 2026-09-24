import { existsSync, readFileSync, statSync } from 'fs';
import * as path from 'node:path';
import type { UserConfig } from 'vite';
import { findSharedKey } from './plugins/pluginProxySharedModule_preBuild';
import type { NormalizedModuleFederationOptions } from './utils/normalizeModuleFederationOptions';
import {
  findModuleImportDescriptors,
  getScannableModuleSource,
  type ModuleImportDescriptor,
} from './utils/htmlEntryUtils';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import {
  addUsedRemote,
  markPreloadRemote,
  markStaticRemote,
} from './virtualModules/virtualRemotes';

const JSX_SOURCE_EXTENSIONS = ['.jsx', '.tsx'];

// Config hooks can change files between instances. Reuse imports only when
// fresh filesystem metadata confirms that the source has not changed.
const entryScans = new WeakMap<
  UserConfig,
  Map<string, { version: string; imports: ModuleImportDescriptor[] }>
>();

export function scanEntryImports(
  config: UserConfig,
  options: NormalizedModuleFederationOptions,
  projectRoot: string,
  registerSharedDependencies = true,
  entryFiles: string[] = []
): boolean {
  const sourceExtensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
  const root = path.resolve(projectRoot);
  const pendingFiles: Array<{ file: string; preloadStaticRemotes: boolean }> = [];
  const scannedFiles = new Map<string, boolean>();
  const resolvedImports = new Map<string, string | undefined>();
  const fileVersions = new Map<string, string>();
  let importsByFile = entryScans.get(config);
  if (!importsByFile) {
    importsByFile = new Map();
    entryScans.set(config, importsByFile);
  }
  let hasJsxFiles = false;
  const addFileToScan = (
    request: string,
    importer = path.join(root, 'index.html'),
    preloadStaticRemotes = false
  ) => {
    const importWithoutQuery = request.replace(/[?#].*$/, '');
    if (
      !importWithoutQuery.startsWith('.') &&
      !importWithoutQuery.startsWith('/') &&
      !path.isAbsolute(importWithoutQuery)
    )
      return;
    const base = importWithoutQuery.startsWith('/')
      ? path.resolve(root, `.${importWithoutQuery}`)
      : path.resolve(path.dirname(importer), importWithoutQuery);
    const relative = path.relative(root, base);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    if (!resolvedImports.has(base)) {
      const candidates = [
        base,
        ...sourceExtensions.map((extension) => `${base}${extension}`),
        ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
      ];
      resolvedImports.set(
        base,
        candidates.find((candidate) => {
          try {
            const stat = statSync(candidate, { bigint: true });
            if (!stat.isFile()) return false;
            fileVersions.set(
              candidate,
              `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
            );
            return true;
          } catch {
            return false;
          }
        })
      );
    }
    const file = resolvedImports.get(base);
    if (file && (!scannedFiles.has(file) || (preloadStaticRemotes && !scannedFiles.get(file)))) {
      pendingFiles.push({ file, preloadStaticRemotes });
    }
  };

  const htmlEntries = entryFiles.filter((file) => file.endsWith('.html'));
  const htmlEntryPaths = htmlEntries.length
    ? htmlEntries
    : entryFiles.length === 0
      ? [path.join(root, 'index.html')]
      : [];
  for (const htmlEntry of htmlEntryPaths) {
    if (existsSync(htmlEntry)) {
      const html = readFileSync(htmlEntry, 'utf8');
      for (const match of html.matchAll(
        /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=(['"])([^'"]+)\1)[^>]*>/gi
      )) {
        addFileToScan(match[2], htmlEntry, true);
      }
    }
  }
  for (const entry of entryFiles.filter((file) => !file.endsWith('.html'))) {
    const relativeEntry = path.relative(root, entry);
    addFileToScan(
      relativeEntry.startsWith('.') ? relativeEntry : `./${relativeEntry}`,
      path.join(root, 'index.html'),
      true
    );
  }
  for (const expose of Object.values(options.exposes ?? {})) {
    addFileToScan(expose.import);
  }

  while (pendingFiles.length) {
    const { file, preloadStaticRemotes } = pendingFiles.pop()!;
    if (scannedFiles.get(file) || (scannedFiles.has(file) && !preloadStaticRemotes)) continue;
    scannedFiles.set(file, preloadStaticRemotes);
    // A file first found through a dynamic import or an exposed module may also
    // have a static import. Check its imports again for remote modules to preload,
    // using the cached imports instead of reading and parsing the file again.
    const version = fileVersions.get(file)!;
    let source = importsByFile.get(file);
    if (!source || source.version !== version) {
      const code = getScannableModuleSource(file, readFileSync(file, 'utf8'));
      source = { version, imports: findModuleImportDescriptors(code) };
      importsByFile.set(file, source);
    }
    if (JSX_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) hasJsxFiles = true;
    for (const { source: request, kind, typeOnly } of source.imports) {
      const isStatic = kind === 'static' && !typeOnly;
      const remoteAlias =
        preloadStaticRemotes && isStatic && request
          ? Object.keys(options.remotes).find(
              (name) => request === name || request.startsWith(`${name}/`)
            )
          : undefined;
      const sharedKey = !typeOnly && request && findSharedKey(request, options.shared);
      if (remoteAlias) {
        addUsedRemote(remoteAlias, request, options);
        markStaticRemote(request, options);
        markPreloadRemote(request, options);
      } else if (sharedKey && registerSharedDependencies) {
        addUsedShares(request, options);
      } else if (request && !typeOnly) {
        addFileToScan(request, file, preloadStaticRemotes && isStatic);
      }
    }
  }
  return hasJsxFiles;
}
