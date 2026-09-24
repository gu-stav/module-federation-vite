import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { ConfigEnv, DepOptimizationOptions, Rolldown, UserConfig } from 'vite';
import {
  excludeSharedSubDependencies,
  getSharedPackageFromFile,
  isSharedPackageDependency,
} from './plugins/pluginProxySharedModule_preBuild';
import { normalizePathForImport } from './utils/buildPaths';
import {
  hasShared,
  type NormalizedModuleFederationOptions,
  type ShareItem,
  type NormalizedShared,
} from './utils/normalizeModuleFederationOptions';
import {
  getInstalledPackageEntry,
  getInstalledPackageJson,
  getPackageName,
  getPackageNameFromNodeModulePath,
  resolveImportPath,
  resolveModulePath,
} from './utils/packageUtils';
import {
  getCommonSharedSubpaths,
  isAssetLikeImport,
  isViteOptimizableEntry,
} from './utils/pathNormalization';
import { getRuntimePluginSpecifier } from './utils/runtimePluginSpecifier';
import { findSharedKey, getSharedRequest, getSharedRuntimeKey } from './utils/sharedKeyMatcher';
import { SSR_ONLY_RUNTIME_PLUGINS } from './utils/ssrCapabilities';
import { createViteEncodedIdPrefixRegExp } from './utils/VirtualModule';
import {
  addConfiguredShare,
  addUsedShares,
  writeLocalSharedImportMap,
} from './virtualModules/virtualRemoteEntry';
import { LOAD_SHARE_TAG } from './virtualModules/shareTags';
import {
  getLoadShareModulePath,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualModules/virtualShared_preBuild';

type EsbuildPlugin = NonNullable<
  NonNullable<DepOptimizationOptions['esbuildOptions']>['plugins']
>[number];

type DependencyPreparationContext = {
  root: string;
  command: ConfigEnv['command'];
  isRolldown: boolean;
  isVinext: boolean;
};

function isGeneratedSharedModule(importer: string | undefined): boolean {
  return !!importer && (importer.includes(LOAD_SHARE_TAG) || importer.includes('__prebuild__'));
}

function isReactDomSelfReference(source: string, importer: string | undefined): boolean {
  return source === 'react-dom' && getPackageNameFromNodeModulePath(importer ?? '') === 'react-dom';
}

// Exclude missing package exports and files Vite cannot optimize, such as .tsx.
// This avoids a "Cannot optimize dependency" warning on each dev server start.
function canOptimizePackage(subpath: string, projectRoot: string): boolean {
  try {
    return isViteOptimizableEntry(
      resolveModulePath(subpath, path.join(projectRoot, 'package.json'))
    );
  } catch (error) {
    // require.resolve can reject an ESM-only package that Vite can load. Try its
    // import export condition so Vite can convert any CommonJS dependencies for
    // the browser. Only try this for the package entry: a subpath such as
    // react/compiler-runtime may be missing from the installed version.
    // https://github.com/module-federation/vite/issues/974
    const isPackageSubpath = subpath.split('/').length > (subpath.startsWith('@') ? 2 : 1);
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' &&
      !isPackageSubpath
    ) {
      const entry = resolvePackageImportEntry(subpath, projectRoot);
      return entry !== undefined && existsSync(entry) && isViteOptimizableEntry(entry);
    }
    return false;
  }
}

const VITE_DEV_IMPORT_CONDITIONS = new Set([
  'browser',
  'development',
  'import',
  'module',
  'default',
]);

function resolveExportPath(target: unknown): string | undefined {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveExportPath(candidate);
      if (resolved) return resolved;
    }
    return undefined;
  }
  if (!target || typeof target !== 'object') return undefined;

  for (const [condition, candidate] of Object.entries(target)) {
    if (!VITE_DEV_IMPORT_CONDITIONS.has(condition)) continue;
    const resolved = resolveExportPath(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolvePackageImportEntry(packageName: string, projectRoot: string): string | undefined {
  const installed = getInstalledPackageJson(packageName, { cwd: projectRoot });
  if (!installed) return undefined;

  const exportsField = installed.packageJson.exports;
  let rootExport: unknown = exportsField;
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    if (Object.keys(exportsField).some((key) => key.startsWith('.'))) {
      rootExport = '.' in exportsField ? exportsField['.'] : undefined;
    }
  }

  const target = resolveExportPath(rootExport);
  if (!target?.startsWith('./')) return undefined;
  const resolved = path.resolve(installed.dir, target);
  const relative = path.relative(installed.dir, resolved);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return resolved;
}

/**
 * Add linked shared packages and exposed modules to Vite's scan entries.
 * Vite cannot follow their imports through loadShare virtual modules. Scanning
 * the source entries lets it find dependencies before the first browser request,
 * avoiding repeated dependency optimization as more modules are requested.
 */
function addDependencyScanEntries(
  optimizeDeps: NonNullable<UserConfig['optimizeDeps']>,
  shared: NormalizedShared,
  projectRoot: string,
  exposes: NormalizedModuleFederationOptions['exposes'],
  outDir: string
): void {
  const additions = new Set<string>();

  const entries = new Set(
    Array.isArray(optimizeDeps.entries)
      ? optimizeDeps.entries
      : optimizeDeps.entries
        ? [optimizeDeps.entries]
        : [
            '**/*.html',
            '!**/node_modules/**',
            `!**/${outDir.replace(/\\/g, '/')}/**`,
            '!**/__tests__/**',
            '!**/coverage/**',
          ]
  );

  for (const [packageName, sharedDependency] of Object.entries(shared ?? {})) {
    if (sharedDependency?.shareConfig?.import === false) continue;
    const configuredImport = sharedDependency?.shareConfig?.import;
    if (typeof configuredImport === 'string') {
      const entry = path.isAbsolute(configuredImport)
        ? configuredImport
        : path.resolve(projectRoot, configuredImport);
      if (existsSync(entry) && !entry.replaceAll('\\', '/').includes('/node_modules/')) {
        additions.add(entry);
        continue;
      }
    }
    const installed = getInstalledPackageJson(packageName, { cwd: projectRoot });
    if (!installed || installed.dir.replaceAll('\\', '/').includes('/node_modules/')) continue;
    const entry = getInstalledPackageEntry(packageName, { cwd: projectRoot });
    if (entry && existsSync(entry)) additions.add(entry);
  }

  for (const expose of Object.values(exposes ?? {})) {
    const source = expose.import;
    if (source.startsWith('.') || path.isAbsolute(source)) {
      const entry = path.resolve(projectRoot, source);
      if (existsSync(entry)) additions.add(entry);
    }
  }

  if (additions.size === 0) return;

  for (const entry of additions) entries.add(entry);
  optimizeDeps.entries = [...entries];
}

function generateSharedExports(id: string): string {
  const source = JSON.stringify(id);
  return `import * as __mfShared from ${source};
export * from ${source};
export default __mfShared.default ?? __mfShared;`;
}

function createSharedOptimizerPlugins(
  options: NormalizedModuleFederationOptions,
  shared: NormalizedShared,
  { root, command, isRolldown }: DependencyPreparationContext
) {
  // Many imports resolve to the same wrapper during one optimization pass.
  // Start fresh on the next pass; load hooks still refresh environment-specific code.
  const preparedShares = new Map<string, ShareItem>();
  const writeSharedModules = (source: string, sharedDependency: ShareItem) => {
    if (preparedShares.get(source) === sharedDependency) return;
    writeLoadShareModule(source, sharedDependency, command, isRolldown, options);
    if (sharedDependency.shareConfig?.import !== false)
      writePreBuildLibPath(source, sharedDependency, options);
    preparedShares.set(source, sharedDependency);
  };

  return {
    rolldown: {
      name: 'module-federation:optimize-shared-resolver',
      buildStart() {
        preparedShares.clear();
      },
      load(id) {
        const optimizedRequirePrefix = 'module-federation:optimized-require-';
        if (!id.startsWith(optimizedRequirePrefix)) return;
        const sourcePackage = id.slice(optimizedRequirePrefix.length);
        if (sourcePackage !== 'react' && sourcePackage !== 'react-dom') return;
        const loadSharePath = getLoadShareModulePath(sourcePackage, isRolldown, options);
        // Keep the virtual module ID here. Vite treats an encoded /@id/__x00__ ID
        // as a file path when analyzing the optimized dependency's imports.
        // The plugin resolves the original ID when the dev server serves the file.
        return generateSharedExports(loadSharePath);
      },
      // Dependency scans may identify entry points in addition to Rolldown's import kinds.
      resolveId(source, importer, resolveOptions?: { kind?: Rolldown.ImportKind | 'entry-point' }) {
        if (createViteEncodedIdPrefixRegExp('virtual:mf:').test(source)) {
          return { id: source, external: true };
        }
        if (isGeneratedSharedModule(importer)) return;
        const key = findSharedKey(source, shared);
        if (!key) return;
        const importerPackage = getSharedPackageFromFile(importer, shared, root);
        const reactDomSelfReference = isReactDomSelfReference(source, importer);
        if (
          !reactDomSelfReference &&
          (importerPackage === getPackageName(key) ||
            (importerPackage && isSharedPackageDependency(key, importerPackage)))
        )
          return;
        if (isAssetLikeImport(source)) return;
        const sharedDependency = shared[key];
        const isReactSingleton =
          source === 'react' && key === 'react' && sharedDependency.shareConfig?.singleton === true;
        const isReactRequire = resolveOptions?.kind?.startsWith('require') && isReactSingleton;
        const isReactDomRequire =
          resolveOptions?.kind?.startsWith('require') && isReactDomSelfReference(source, importer);
        if (resolveOptions?.kind?.startsWith('require') && !isReactRequire && !isReactDomRequire)
          return;
        const isCommonJsImporter =
          !!importer && (importer.endsWith('.cjs') || importer.includes('/cjs/'));
        if (isCommonJsImporter && !isReactSingleton && !isReactDomRequire) return;
        if (resolveOptions?.kind !== 'entry-point') addUsedShares(source, options);
        if (isReactRequire || isReactDomRequire) {
          writeSharedModules(source, sharedDependency);
          return { id: `module-federation:optimized-require-${source}` };
        }
        const loadSharePath = getLoadShareModulePath(source, isRolldown, options);
        writeSharedModules(source, sharedDependency);
        return { id: loadSharePath, external: true };
      },
    } satisfies Rolldown.Plugin,
    esbuild: {
      name: 'module-federation:optimize-shared-proxy',
      setup(build) {
        build.onStart(() => {
          preparedShares.clear();
        });
        build.onResolve({ filter: createViteEncodedIdPrefixRegExp('virtual:mf:') }, (request) => ({
          path: request.path,
          external: true,
        }));
        build.onResolve({ filter: /.*/ }, (request) => {
          if (request.kind === 'entry-point') return;
          if (!request.importer || request.namespace === 'mf-shared') return;
          if (isGeneratedSharedModule(request.importer)) return;
          const key = findSharedKey(request.path, shared);
          if (!key || isAssetLikeImport(request.path)) return;
          const importerPackage = getSharedPackageFromFile(request.importer, shared, root);
          if (
            importerPackage === getPackageName(request.path) &&
            !isReactDomSelfReference(request.path, request.importer)
          )
            return;
          if (importerPackage && isSharedPackageDependency(key, importerPackage)) return;
          addUsedShares(request.path, options);
          if (request.kind === 'import-statement' || request.kind === 'dynamic-import') {
            const sharedDependency = shared[key];
            const loadSharePath = getLoadShareModulePath(request.path, isRolldown, options);
            writeSharedModules(request.path, sharedDependency);
            return { path: loadSharePath, external: true };
          }
          return { path: request.path, namespace: 'mf-shared' };
        });
        build.onLoad({ filter: /.*/, namespace: 'mf-shared' }, (request) => {
          const key = findSharedKey(request.path, shared);
          if (!key) return;
          const sharedDependency = shared[key];
          const loadSharePath = getLoadShareModulePath(request.path, isRolldown, options);
          writeSharedModules(request.path, sharedDependency);
          return {
            loader: 'js',
            resolveDir: root,
            contents: generateSharedExports(loadSharePath),
          };
        });
      },
    } satisfies EsbuildPlugin,
  };
}

const optimizeDepsPlugin = {
  name: 'normalizeOptimizeDeps',
  config: (config: UserConfig) => {
    const optimizeDeps = (config.optimizeDeps ||= {});
    optimizeDeps.include ||= [];
    optimizeDeps.exclude ||= [];
    optimizeDeps.needsInterop ||= [];
  },
  configResolved: ({ optimizeDeps }: Pick<UserConfig, 'optimizeDeps'>) => {
    if (!optimizeDeps?.include?.length || !optimizeDeps.exclude?.length) return;
    const included = new Set(optimizeDeps.include);
    optimizeDeps.exclude = optimizeDeps.exclude.filter((dep) => !included.has(dep));
  },
};

/**
 * Configures dependency optimization and generates virtual modules for shared
 * dependencies. Keep these together so included and excluded packages, including
 * package subpaths, get the virtual modules they need.
 */
export function createDependencyPreparation(options: NormalizedModuleFederationOptions) {
  const { shared, remotes } = options;
  const isLitPackage = (packageName: string) =>
    packageName === 'lit' || packageName.startsWith('lit/');

  return {
    excludeRemotesFromOptimization(config: UserConfig, command: ConfigEnv['command']) {
      if (command === 'serve') {
        config.optimizeDeps = config.optimizeDeps || {};
        config.optimizeDeps.exclude = config.optimizeDeps.exclude || [];
        config.optimizeDeps.include = config.optimizeDeps.include || [];
        // Keep imports such as import("remote/x") out of dependency optimization.
        // The plugin must resolve them as remote modules, not local packages.
        config.optimizeDeps.exclude.push(...Object.keys(remotes || {}));
      }
    },
    prepareSharedDependencies(config: UserConfig, configContext: DependencyPreparationContext) {
      const { root, command, isRolldown, isVinext } = configContext;
      // Register shared dependencies before localSharedImportMap is loaded,
      // both in the dev server and during builds.
      if (hasShared(options)) {
        if (command === 'serve') {
          excludeSharedSubDependencies(shared);
          config.optimizeDeps = config.optimizeDeps || {};
          config.optimizeDeps.include = config.optimizeDeps.include || [];
          const optimizeDeps = config.optimizeDeps;
          const optimizers = createSharedOptimizerPlugins(options, shared, configContext);
          if (isRolldown) {
            optimizeDeps.rolldownOptions ??= {};
            optimizeDeps.rolldownOptions.plugins ??= [];
            const plugins = optimizeDeps.rolldownOptions.plugins;
            if (!Array.isArray(plugins)) throw new TypeError('plugins.push is not a function');
            plugins.push(optimizers.rolldown);
          } else {
            optimizeDeps.esbuildOptions ??= {};
            optimizeDeps.esbuildOptions.plugins ??= [];
            optimizeDeps.esbuildOptions.plugins.push(optimizers.esbuild);
          }
        }
        for (const key of Object.keys(shared)) {
          const sharedDependency: ShareItem = shared[key];
          const request = getSharedRequest(key, sharedDependency);
          const runtimeSharedKey = getSharedRuntimeKey(key, sharedDependency);
          if (key.endsWith('/') || request.endsWith('/') || runtimeSharedKey.endsWith('/')) {
            if (command === 'serve' && sharedDependency.shareConfig?.import !== false) {
              const optimizeDeps = (config.optimizeDeps ??= {});
              optimizeDeps.include ??= [];
              optimizeDeps.exclude ??= [];
              for (const subpath of getCommonSharedSubpaths(request)) {
                writePreBuildLibPath(subpath, sharedDependency, options);
                if (canOptimizePackage(subpath, root)) {
                  optimizeDeps.include.push(subpath);
                } else {
                  optimizeDeps.exclude.push(subpath);
                }
              }
            }
            continue;
          }
          if (isVinext && runtimeSharedKey === 'react') {
            addConfiguredShare(runtimeSharedKey, options);
            continue;
          }
          getLoadShareModulePath(runtimeSharedKey, isRolldown, options);
          writeLoadShareModule(runtimeSharedKey, sharedDependency, command, isRolldown, options);
          // Shared dependencies with import: false have no local fallback.
          if (sharedDependency.shareConfig?.import !== false) {
            writePreBuildLibPath(runtimeSharedKey, sharedDependency, options);
          }
          addConfiguredShare(runtimeSharedKey, options);
          if (command === 'serve' && sharedDependency.shareConfig?.import !== false) {
            const optimizeDeps = (config.optimizeDeps ??= {});
            optimizeDeps.include ??= [];
            optimizeDeps.exclude ??= [];
            // Exclude Lit to keep its modules' initialization order, and exclude
            // source files Vite cannot optimize, such as .jsx and .tsx.
            // Other shared dependencies need optimization to convert CommonJS
            // local fallbacks to ESM. The shared module cache and loadShare
            // still ensure that singleton dependencies use one instance.
            const shouldBypassOptimizeDep =
              isLitPackage(runtimeSharedKey) || !canOptimizePackage(runtimeSharedKey, root);
            if (optimizeDeps.include.includes(runtimeSharedKey)) {
              optimizeDeps.exclude = optimizeDeps.exclude.filter((dep) => dep !== runtimeSharedKey);
            } else if (shouldBypassOptimizeDep || optimizeDeps.exclude.includes(runtimeSharedKey)) {
              optimizeDeps.exclude.push(runtimeSharedKey);
            } else {
              optimizeDeps.include.push(runtimeSharedKey);
            }
            const commonSubpaths =
              sharedDependency.shareConfig.request === undefined &&
              sharedDependency.shareConfig.shareKey === undefined
                ? getCommonSharedSubpaths(runtimeSharedKey)
                : [];
            for (const subpath of commonSubpaths) {
              const canResolveSubpath = canOptimizePackage(subpath, root);
              if (
                ['react/compiler-runtime', 'react-dom/client', 'react-dom/profiling'].includes(
                  subpath
                ) &&
                !canResolveSubpath
              ) {
                // These entry points only exist in newer React versions.
                // Generating their prebuild wrappers for older versions creates
                // imports that Vite cannot resolve.
                optimizeDeps.exclude.push(subpath);
                continue;
              }
              getLoadShareModulePath(subpath, isRolldown, options);
              writeLoadShareModule(subpath, sharedDependency, command, isRolldown, options);
              writePreBuildLibPath(subpath, sharedDependency, options);
              addConfiguredShare(subpath, options);
              if (canResolveSubpath) {
                optimizeDeps.include.push(subpath);
                // Optimize subpaths such as react-dom/client together with their package entry.
                if (runtimeSharedKey === 'react-dom') {
                  optimizeDeps.include.push(`${runtimeSharedKey} > ${subpath}`);
                }
              } else {
                optimizeDeps.exclude.push(subpath);
              }
            }
          }
        }
        writeLocalSharedImportMap(options);
      }
      if (command === 'serve') {
        config.optimizeDeps ??= {};
        addDependencyScanEntries(
          config.optimizeDeps,
          shared,
          root,
          options.exposes,
          config.build?.outDir ?? 'dist'
        );
        config.optimizeDeps.include = [...new Set(config.optimizeDeps.include ?? [])].sort();
        config.optimizeDeps.exclude = [...new Set(config.optimizeDeps.exclude ?? [])].sort();
      }
    },
    includeRuntimeDependencies(config: UserConfig, needsRuntimeHelpers: boolean) {
      const optimizeDeps = (config.optimizeDeps ||= {});
      const include = (optimizeDeps.include ||= []);
      include.push('@module-federation/runtime');
      if (needsRuntimeHelpers) {
        include.push('@module-federation/runtime/helpers');
      }

      // Include runtime plugins before Vite starts dependency optimization to avoid 504 errors.
      // Skip SSR-only plugins because they import Node.js modules.
      options.runtimePlugins.forEach((runtimePlugin) => {
        const pluginSpecifier = getRuntimePluginSpecifier(runtimePlugin);
        if (SSR_ONLY_RUNTIME_PLUGINS.has(pluginSpecifier)) return;
        // Only add bare imports to optimizeDeps
        if (
          pluginSpecifier &&
          !pluginSpecifier.startsWith('.') &&
          !pluginSpecifier.startsWith('/') &&
          !pluginSpecifier.startsWith('\0') &&
          !pluginSpecifier.startsWith('virtual:')
        ) {
          let optimizedImport = pluginSpecifier;
          if (
            pluginSpecifier === '@module-federation/dts-plugin/dynamic-remote-type-hints-plugin'
          ) {
            try {
              optimizedImport = normalizePathForImport(resolveImportPath(pluginSpecifier));
            } catch {
              optimizedImport = pluginSpecifier;
            }
          }
          include.push(optimizedImport);
        }
      });
    },
    optimizeDepsPlugin,
  };
}
