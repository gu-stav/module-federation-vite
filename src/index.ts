import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { ConfigEnv, EnvironmentOptions, Plugin, ResolvedConfig, UserConfig } from 'vite';
import { version as viteVersion } from 'vite';
import { createVirtualModuleLoading } from './virtualModuleLoading';
import { createDependencyPreparation } from './dependencyPreparation';
import { createChunkPlacement } from './chunkPlacement';
import addEntry, { getBuildInput } from './plugins/pluginAddEntry';
import { checkAliasConflicts } from './plugins/pluginCheckAliasConflicts';
import pluginDevRemoteHmr, { shouldIgnoreFile } from './plugins/pluginDevRemoteHmr';
import pluginExternalRuntimeCore from './plugins/pluginExternalRuntimeCore';
import pluginLazyConsumeOnlyShares from './plugins/pluginLazyConsumeOnlyShares';
import pluginManifest from './plugins/pluginMFManifest';
import pluginProxyRemoteEntry from './plugins/pluginProxyRemoteEntry';
import pluginProxyRemotes from './plugins/pluginProxyRemotes';
import { findSharedKey, proxySharedModule } from './plugins/pluginProxySharedModule_preBuild';
import { pluginRemoteNamedExports } from './plugins/pluginRemoteNamedExports';
import { pluginSSRRemoteEntry } from './plugins/pluginSSRRemoteEntry';
import pluginVarRemoteEntry from './plugins/pluginVarRemoteEntry';
import aliasToArrayPlugin from './utils/aliasToArrayPlugin';
import { escapeRegExp } from './utils/regexEscape';
import {
  collectLoadShareProxyChunks,
  collectSystemProxyInfos,
  rewriteEsmProxyConsumers,
  rewriteSystemProxyConsumers,
} from './utils/bundleHelpers';
import { normalizePathForImport } from './utils/buildPaths';
import {
  isFederationControlChunk,
  sanitizeFederationControlChunk,
} from './utils/controlChunkSanitizer';
import { isTestEnv } from './utils/isTestEnv';
import { createModuleFederationError, mfWarn } from './utils/logger';
import type {
  ModuleFederationOptions,
  NormalizedModuleFederationOptions,
  PluginExperimentsOptions,
  PluginManifestOptions,
  SsrEntryLoaderConfig,
  SsrEntryLoaderStrategy,
  TreeShakingConfig,
} from './utils/normalizeModuleFederationOptions';
import {
  hasRemotes,
  hasShared,
  normalizeModuleFederationOptions,
  resolveSharedVersions,
} from './utils/normalizeModuleFederationOptions';
import {
  getIsRolldown,
  getPackageName,
  hasPackageDependency,
  resolveImportPath,
  setPackageDetectionCwd,
} from './utils/packageUtils';
import {
  applyRuntimeCapabilityDefines,
  getRuntimeCapabilityConfigurationWarnings,
} from './utils/runtimeCapabilityOptimization';
import {
  getSsrCapabilities,
  isServerEnvironment,
  isSsrConfig,
  SSR_ENTRY_LOADER_SPECIFIER,
} from './utils/ssrCapabilities';
import { getRuntimePluginSpecifier } from './utils/runtimePluginSpecifier';
import {
  findModuleImportDescriptors,
  getScannableModuleSource,
  type ModuleImportDescriptor,
} from './utils/htmlEntryUtils';
import {
  getHostAutoInitPath,
  getRemoteEntryId,
  initVirtualModules,
  LOAD_SHARE_TAG,
  writeLocalSharedImportMap,
} from './virtualModules';
import { getVirtualExposesId } from './virtualModules/virtualExposes';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import {
  addUsedRemote,
  ensureUsedRemote,
  markPreloadRemote,
  markStaticRemote,
} from './virtualModules/virtualRemotes';
import { getRuntimeInitStatusImportId } from './virtualModules/virtualRuntimeInitStatus';
import { findEagerFallbacksInSharedChunk } from './virtualModules/loadShareSharedChunk';
import { resetConcreteSharedImportSourceCache } from './virtualModules/virtualShared_preBuild';

type ViteWatchOptions = NonNullable<NonNullable<UserConfig['server']>['watch']>;
type ViteWatchConfig = ViteWatchOptions | boolean | null | undefined;

function normalizeVinextRscPreloadHints(code: string): string {
  return code
    .replace(/(:HL\[[^\]\n]*?,)"stylesheet"/g, '$1"style"')
    .replace(/(:HL\[[^\]\n]*?,)\\"stylesheet\\"/g, '$1\\"style\\"');
}

function ignoreFederationGeneratedFiles(
  config: UserConfig,
  options: NormalizedModuleFederationOptions
): void {
  config.server ??= {};
  const watch = config.server.watch as ViteWatchConfig;

  if (watch === false || watch === null) {
    return;
  }

  const watchOptions = watch === true || watch === undefined ? {} : watch;
  config.server.watch = watchOptions;

  const federationIgnore = (file: string) => shouldIgnoreFile(file, options);
  const ignored = watchOptions.ignored;
  if (!ignored) {
    watchOptions.ignored = federationIgnore;
    return;
  }
  if (Array.isArray(ignored)) {
    ignored.push(federationIgnore);
    return;
  }
  watchOptions.ignored = [ignored, federationIgnore];
}

type ModulePreloadResolveContext = { hostId: string; hostType: 'html' | 'js' };
type ResolveAliasEntry = { find: string | RegExp; replacement: string };
type BundleChunkLike = {
  type: 'chunk';
  fileName: string;
  code: string;
  imports?: string[];
  modules?: Record<string, unknown>;
};
type BundleAssetLike = { type: 'asset'; fileName: string };
type BundleLike = Record<string, BundleChunkLike | BundleAssetLike>;
type NormalizedOutputOptionsLike = { dir?: string };
type RenderedChunkLike = { fileName: string };

function isOutputChunk(chunk: BundleLike[string]): chunk is BundleChunkLike {
  return chunk.type === 'chunk';
}

function appendResolveAlias(config: UserConfig, alias: ResolveAliasEntry): void {
  const resolve = (config.resolve ??= {});
  const existingAlias = resolve.alias;
  if (!existingAlias) {
    resolve.alias = [alias];
    return;
  }
  if (Array.isArray(existingAlias)) {
    existingAlias.push(alias);
    return;
  }
  resolve.alias = [
    ...Object.entries(existingAlias).map(([find, replacement]) => ({ find, replacement })),
    alias,
  ];
}

// `<dir>/index.js` runtime entry, captured as (directory, extension) so the
// sibling `helpers` module can be addressed with the same extension.
const RUNTIME_INDEX_ENTRY_RE = /^(.*[\\/])index(\.[cm]?js)$/;
const TRAILING_SLASH_RE = /\/$/;

function getRuntimeHelpersImplementation(runtimeImplementation: string): string {
  const indexEntryMatch = RUNTIME_INDEX_ENTRY_RE.exec(runtimeImplementation);
  if (indexEntryMatch) {
    return normalizePathForImport(`${indexEntryMatch[1]}helpers${indexEntryMatch[2]}`);
  }

  const extension = path.extname(runtimeImplementation);
  if (extension) {
    return normalizePathForImport(
      path.join(path.dirname(runtimeImplementation), `helpers${extension}`)
    );
  }

  if (path.isAbsolute(runtimeImplementation) || runtimeImplementation.startsWith('.')) {
    return normalizePathForImport(path.join(runtimeImplementation, 'helpers'));
  }

  return `${runtimeImplementation.replace(TRAILING_SLASH_RE, '')}/helpers`;
}

const UNSAFE_JS_SOURCE_CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeUnsafeJsSourceChars(str: string): string {
  return str.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, (char) => {
    return UNSAFE_JS_SOURCE_CHAR_MAP[char] ?? char;
  });
}

function isFederationHtmlPreloadDependency(dep: string, includeSharedRuntime = false): boolean {
  const file = path.basename(dep);
  if (
    file.includes('__mfe_internal__') ||
    file.includes('virtual_mf-') ||
    file.includes('localSharedImportMap') ||
    file.includes('hostInit')
  ) {
    return true;
  }

  return (
    includeSharedRuntime &&
    (file.includes('preload-helper') ||
      file.includes('rolldown-runtime') ||
      file.startsWith('dist-'))
  );
}

// React Router's build plugin appends a synthetic `?__react-router-build-client-route`
// entry per route that isn't a real module on disk, so it must be excluded before this
// scan tries to read it as a source file.
function isReactRouterBuildClientRouteInput(entry: string): boolean {
  return /[?&]__react-router-build-client-route(?:[=&]|$)/.test(entry);
}

/**
 * Files whose JSX the compiler rewrites to an automatic-runtime import.
 * Vite only applies the JSX transform to these extensions by default.
 */
const JSX_SOURCE_EXTENSIONS = ['.jsx', '.tsx'];

type JsxTransformOptions = {
  jsx?: string | { runtime?: string; importSource?: string; development?: boolean };
  jsxImportSource?: string;
  jsxDev?: boolean;
};

function getAutomaticJsxRuntime(config: ResolvedConfig): string | undefined {
  for (const candidate of [config.oxc, config.esbuild]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const transform = candidate as JsxTransformOptions;
    const jsx = transform.jsx;
    const runtime = typeof jsx === 'object' ? jsx.runtime : jsx;
    if (runtime && runtime !== 'automatic') return undefined;
    if (runtime !== 'automatic') continue;
    const importSource =
      (typeof jsx === 'object' ? jsx.importSource : undefined) ??
      transform.jsxImportSource ??
      'react';
    const development =
      (typeof jsx === 'object' ? jsx.development : undefined) ?? transform.jsxDev ?? true;
    return `${importSource}/${development ? 'jsx-dev-runtime' : 'jsx-runtime'}`;
  }
  return undefined;
}

function scanEntryImports(
  options: NormalizedModuleFederationOptions,
  projectRoot: string,
  registerSharedDependencies = true,
  entryFiles: string[] = []
): boolean {
  const sourceExtensions = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.vue', '.svelte'];
  const root = path.resolve(projectRoot);
  const pendingFiles: Array<{ file: string; preloadStaticRemotes: boolean }> = [];
  const scannedFiles = new Map<string, boolean>();
  // Cache file lookups, including missing files, for this scan only.
  // The next config hook must see edited and newly created files.
  const resolvedImports = new Map<string, string | undefined>();
  const importsByFile = new Map<string, ModuleImportDescriptor[]>();
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
            return statSync(candidate).isFile();
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
    let imports = importsByFile.get(file);
    if (!imports) {
      const code = getScannableModuleSource(file, readFileSync(file, 'utf8'));
      imports = findModuleImportDescriptors(code);
      importsByFile.set(file, imports);
    }
    if (JSX_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) hasJsxFiles = true;
    for (const { source: request, kind, typeOnly } of imports) {
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

// The compiler injects this import after the textual entry scan. Materialize
// the resolved runtime and its configured root even when optimizeDeps is warm.
function materializeAutomaticJsxRuntime(
  options: NormalizedModuleFederationOptions,
  runtime: string
): boolean {
  if (!findSharedKey(runtime, options.shared)) return false;
  addUsedShares(runtime, options);
  const packageName = getPackageName(runtime);
  if (packageName !== runtime && findSharedKey(packageName, options.shared)) {
    addUsedShares(packageName, options);
  }
  return true;
}

/**
 * Plugin that runs FIRST to register generated virtual modules in the config hook.
 * This prevents 504 "Outdated Optimize Dep" errors by ensuring ids are known
 * before Vite's optimization phase.
 */
function createEarlyVirtualModulesPlugin(
  options: NormalizedModuleFederationOptions,
  dependencies: ReturnType<typeof createDependencyPreparation>
): Plugin {
  const { shared, remotes } = options;
  let hasClientJsxSource = false;
  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command: _command }) {
      if (_command === 'serve') ignoreFederationGeneratedFiles(config, options);

      const root = config.root || process.cwd();
      const buildInput = getBuildInput(config);
      const configuredEntryFiles =
        typeof buildInput === 'string'
          ? [buildInput]
          : Array.isArray(buildInput)
            ? buildInput
            : buildInput && typeof buildInput === 'object'
              ? Object.values(buildInput)
              : [];
      const resolvedConfiguredEntryFiles = configuredEntryFiles
        .map((entry) => String(entry))
        .filter((entry) => !isReactRouterBuildClientRouteInput(entry))
        .map((entry) => entry.split(/[?#]/)[0])
        .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(root, entry)));
      resetConcreteSharedImportSourceCache();
      setPackageDetectionCwd(root);
      resolveSharedVersions(shared, root);
      const isVinext = hasPackageDependency('vinext');

      // Configure SSR runtime with the host's remotes so server-side loadRemote
      // knows the entry URL for each remote when ssrEntryLoader intercepts it.
      // Create core virtual modules
      initVirtualModules(_command, getRemoteEntryId(options), false, options);

      const isRolldown = getIsRolldown(this);

      // Eagerly register configured remotes before localSharedImportMap is
      // first written. In build, remoteEntry can be traced before app modules
      // hit the remote alias resolver, which otherwise leaves usedRemotes empty
      // in the emitted localSharedImportMap chunk.
      // Register the remote key only — a configured alias is not an imported
      // root (`.`) expose. Actual modules are recorded when the app imports them.
      if (remotes && Object.keys(remotes).length > 0) {
        for (const key of Object.keys(remotes)) {
          ensureUsedRemote(key, options);
        }
        dependencies.excludeRemotesFromOptimization(config, _command);
      }

      if (!config.build?.ssr && (hasShared(options) || hasRemotes(options))) {
        // The static remote registry is also needed by the production host
        // bootstrap. Keep share/optimize-deps discovery serve-only, but scan
        // the same client entry graph during build so the bootstrap can wait
        // for only the remotes imported synchronously by that graph.
        const hasJsxSource = scanEntryImports(
          options,
          root,
          _command === 'serve',
          resolvedConfiguredEntryFiles
        );
        if (_command === 'serve') hasClientJsxSource = hasJsxSource;
      }

      dependencies.prepareSharedDependencies(config, {
        root,
        command: _command,
        isRolldown,
        isVinext,
      });
    },

    configResolved(config) {
      if (hasClientJsxSource) {
        const automaticJsxRuntime = getAutomaticJsxRuntime(config);
        if (automaticJsxRuntime && materializeAutomaticJsxRuntime(options, automaticJsxRuntime)) {
          writeLocalSharedImportMap(options);
        }
      }

      const viteMajor = parseInt(viteVersion, 10);
      const ssrCapabilities = getSsrCapabilities(
        viteMajor,
        config.command as 'serve' | 'build',
        hasRemotes(options),
        isSsrConfig(config)
      );
      if (!ssrCapabilities.injectSsrEntryLoader) return;

      const alreadyInjected = options.runtimePlugins.some(
        (p) => getRuntimePluginSpecifier(p) === SSR_ENTRY_LOADER_SPECIFIER
      );
      if (alreadyInjected) return;

      const projectRequire = createRequire(pathToFileURL(path.join(config.root, 'package.json')));
      const sharedKeys = Object.keys(options.shared ?? {});
      const commonSharedPkgs = [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react/compiler-runtime',
        '@module-federation/runtime',
        '@module-federation/runtime-core',
        '@module-federation/sdk',
      ];
      const resolvedShared: Record<string, string> = {};
      for (const pkg of [...commonSharedPkgs, ...sharedKeys]) {
        try {
          resolvedShared[pkg] = projectRequire.resolve(pkg);
        } catch {
          try {
            resolvedShared[pkg] = resolveImportPath(pkg);
          } catch {
            // Not installed at either location — ssrEntryLoader falls back to
            // runtime resolution from the host app.
          }
        }
      }

      // Only inject when the built subpath export exists. Integration tests
      // run against src/ before a build, so the lib/ export won't be present.
      // Users can still inject manually via runtimePlugins in that case.
      const ssrEntryLoaderSpecifier = SSR_ENTRY_LOADER_SPECIFIER;
      try {
        resolveImportPath(ssrEntryLoaderSpecifier);
        options.runtimePlugins.push([
          ssrEntryLoaderSpecifier,
          {
            resolvedShared,
            ...(options.ssrEntryLoader?.strategy
              ? { strategy: options.ssrEntryLoader.strategy }
              : {}),
          },
        ]);
      } catch {
        // lib/ not built yet — skip silently
      }
    },
  };
}

type DefineConfig = NonNullable<UserConfig['define']>;

type RuntimeDefineContext = {
  target: 'web' | 'node';
  isAstro: boolean;
  defaultDisableSnapshot?: boolean;
};

function applyBuildTimeRuntimeDefines(
  define: DefineConfig,
  options: NormalizedModuleFederationOptions,
  { target, isAstro, defaultDisableSnapshot }: RuntimeDefineContext
): void {
  const envTargetDefineValue = !options.target && isAstro ? 'undefined' : JSON.stringify(target);

  if (!('ENV_TARGET' in define)) {
    define.ENV_TARGET = envTargetDefineValue;
  }
  applyRuntimeCapabilityDefines(define, options, {
    defaultDisableSnapshot,
    onConflict: mfWarn,
  });

  if (options.target && define.ENV_TARGET !== JSON.stringify(options.target)) {
    mfWarn(
      `ENV_TARGET define (${define.ENV_TARGET}) differs from target option ("${options.target}"). ENV_TARGET will not be overridden.`
    );
  }
}

function loadPluginDts(options: NormalizedModuleFederationOptions): any[] {
  if (options.dts === false) {
    return [];
  }

  return [import('./plugins/pluginDts').then(({ default: pluginDts }) => pluginDts(options))];
}

const INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN =
  '@module-federation/vite/injectExternalRuntimeCorePlugin';

function isInjectExternalRuntimeCorePlugin(specifier: string): boolean {
  return (
    specifier === INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN ||
    specifier.includes('injectExternalRuntimeCorePlugin') ||
    // Still recognize the official package if a consumer adds it manually.
    specifier.includes('inject-external-runtime-core-plugin')
  );
}

function hasInjectExternalRuntimeCorePlugin(
  runtimePlugins: Array<string | [string, Record<string, unknown>]>
): boolean {
  return runtimePlugins.some((plugin) =>
    isInjectExternalRuntimeCorePlugin(getRuntimePluginSpecifier(plugin))
  );
}

function resolveInjectExternalRuntimeCorePlugin(): string {
  try {
    return normalizePathForImport(resolveImportPath(INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN));
  } catch {
    // Dev/test before `lib/` exists: resolve the source/companion file beside this module.
    for (const rel of [
      './utils/injectExternalRuntimeCorePlugin.js',
      './utils/injectExternalRuntimeCorePlugin.ts',
    ]) {
      const candidate = fileURLToPath(new URL(rel, import.meta.url));
      if (existsSync(candidate)) return normalizePathForImport(candidate);
    }
    return INJECT_EXTERNAL_RUNTIME_CORE_PLUGIN;
  }
}

function applyExternalRuntimeExperiments(options: NormalizedModuleFederationOptions): void {
  const { experiments } = options;
  if (experiments.provideExternalRuntime) {
    if (!hasInjectExternalRuntimeCorePlugin(options.runtimePlugins)) {
      options.runtimePlugins = options.runtimePlugins.concat(
        resolveInjectExternalRuntimeCorePlugin()
      );
    }
  }
}

function federation(mfUserOptions: ModuleFederationOptions): any[] {
  if (isTestEnv()) return [];
  const options = normalizeModuleFederationOptions(mfUserOptions);
  applyExternalRuntimeExperiments(options);

  const isVinext = hasPackageDependency('vinext');
  const { name, shared, filename, hostInitInjectLocation } = options;
  const hasTreeShakingShared = Object.values(shared).some(
    (share) => !!share.shareConfig.treeShaking
  );
  if (!name) throw createModuleFederationError('name is required');

  const remoteEntryId = getRemoteEntryId(options);
  const virtualExposesId = getVirtualExposesId(options);
  const loading = createVirtualModuleLoading(options, remoteEntryId, virtualExposesId);
  const chunkPlacement = createChunkPlacement(options);
  const dependencies = createDependencyPreparation(options);
  const emittedRuntimeCapabilityWarnings = new Set<string>();

  return [
    loading.loaderPlugin,
    ...(options.experiments.externalRuntime ? [pluginExternalRuntimeCore()] : []),
    // This plugin runs FIRST to register virtual modules before optimization
    createEarlyVirtualModulesPlugin(options, dependencies),
    ...(isVinext
      ? [
          {
            name: 'module-federation-vinext-react-server-build-alias',
            apply: 'build' as const,
            enforce: 'pre' as const,
            resolveId(id: string) {
              const reactServerEntryMap: Record<string, string> = {
                'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
                'react/jsx-dev-runtime': 'react/cjs/react-jsx-dev-runtime.production.js',
                'react/compiler-runtime': 'react/cjs/react-compiler-runtime.production.js',
              };
              if (!(id in reactServerEntryMap)) return;
              const environmentName = (this as { environment?: { name?: string } }).environment
                ?.name;
              if (!environmentName || environmentName === 'client') return;

              const target = reactServerEntryMap[id];
              const projectRequire = createRequire(
                pathToFileURL(path.join(process.cwd(), 'package.json'))
              );
              const reactPackageJson = projectRequire.resolve('react/package.json');
              return path.join(path.dirname(reactPackageJson), target.replace(/^react\//, ''));
            },
          },
        ]
      : []),
    loading.initializationPlugin,
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    dependencies.optimizeDepsPlugin,
    ...loadPluginDts(options),
    pluginDevRemoteHmr(options),
    {
      // Some frameworks (e.g. TanStack Start) assume the bundle has exactly one
      // isEntry chunk and throw when they see extras. MF emits additional entry
      // chunks (hostInit, remoteEntry) that are not the real app
      // entry. Mark them as non-entry before any framework scanner runs.
      name: 'mf:normalize-entry-chunks',
      enforce: 'pre',
      apply: 'build',
      generateBundle(_options: unknown, bundle: Record<string, unknown>) {
        for (const chunk of Object.values(bundle)) {
          if (
            typeof chunk !== 'object' ||
            chunk === null ||
            (chunk as { type: string }).type !== 'chunk' ||
            !(chunk as { isEntry: boolean }).isEntry
          )
            continue;
          const facadeId = (chunk as { facadeModuleId?: string }).facadeModuleId ?? '';
          if (
            facadeId.includes('__mf__virtual') ||
            facadeId.startsWith('virtual:mf-') ||
            facadeId.startsWith('virtual:mf:') ||
            facadeId.startsWith('\0virtual:mf-') ||
            facadeId.startsWith('\0virtual:mf:')
          ) {
            (chunk as { isEntry: boolean }).isEntry = false;
          }
        }
      },
    },
    ...addEntry({
      entryName: 'remoteEntry',
      entryPath: remoteEntryId,
      fileName: filename,
      federationOptions: options,
    }),
    ...addEntry({
      entryName: 'hostInit',
      entryPath: () => getHostAutoInitPath(options),
      inject: hostInitInjectLocation,
      forceClientInjected: Object.keys(options.exposes).length > 0,
      skipTransformFor: Object.values(options.exposes).map((expose) => expose.import),
      federationOptions: options,
    }),
    pluginProxyRemoteEntry({
      options,
      remoteEntryId,
      virtualExposesId,
      getParsePromise: loading.getImportAnalysisPromise,
    }),
    pluginProxyRemotes(options),
    pluginRemoteNamedExports(options),
    ...loading.importAnalysisPlugins,
    ...proxySharedModule({
      shared,
      federationOptions: options,
      getParsePromise: loading.getImportAnalysisPromise,
    }),
    pluginLazyConsumeOnlyShares(options),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      config(config: UserConfig) {
        loading.configureSsrBuild(config);
        const runtimeInitId = getRuntimeInitStatusImportId(options);
        config.build = config.build || {};

        if (config.build.modulePreload !== false) {
          // The configured filename may carry a `[hash]` placeholder (the default
          // is `remoteEntry-[hash]`, emitted as `remoteEntry-<hash>.js`); match
          // the emitted file, not the pattern.
          const remoteEntryBasename = path.posix.basename(options.filename);
          const hashParts = remoteEntryBasename.split(/\[hash(?::\d+)?\]/);
          const remoteEntryFilePattern = new RegExp(
            `^${hashParts.map((part) => escapeRegExp(part)).join('[\\w-]+')}${
              hashParts.length > 1 && !/\.[^/.]+$/.test(remoteEntryBasename) ? '\\.js' : ''
            }$`
          );
          const isRemoteEntryFile = (file: string) =>
            file === remoteEntryBasename || remoteEntryFilePattern.test(file);
          const currentModulePreload =
            config.build.modulePreload && typeof config.build.modulePreload === 'object'
              ? config.build.modulePreload
              : {};
          const existingResolveDependencies = currentModulePreload.resolveDependencies;

          config.build.modulePreload = {
            ...currentModulePreload,
            resolveDependencies(
              filename: string,
              deps: string[],
              context: ModulePreloadResolveContext
            ) {
              const resolvedDeps = existingResolveDependencies
                ? existingResolveDependencies(filename, deps, context)
                : deps;
              const hostFile = path.basename(context.hostId);
              const shouldSkipFederationPreload =
                context.hostType === 'js' &&
                (isRemoteEntryFile(hostFile) ||
                  hostFile.includes('hostInit') ||
                  hostFile.includes('localSharedImportMap'));

              if (shouldSkipFederationPreload) return [];

              const hasFederationHtmlDeps =
                context.hostType === 'html' &&
                resolvedDeps.some((dep) => isFederationHtmlPreloadDependency(dep));
              const hasFederationJsDeps =
                context.hostType === 'js' &&
                resolvedDeps.some((dep) => isFederationHtmlPreloadDependency(dep));

              const treeShakingFallbackDeps = hasTreeShakingShared
                ? (dep: string) => dep.includes('__prebuild__')
                : () => false;

              return hasFederationHtmlDeps || hasFederationJsDeps
                ? resolvedDeps.filter(
                    (dep) =>
                      !isFederationHtmlPreloadDependency(dep, true) && !treeShakingFallbackDeps(dep)
                  )
                : resolvedDeps.filter((dep) => !treeShakingFallbackDeps(dep));
            },
          };
        }

        chunkPlacement.configureBuildOutputs(config.build, runtimeInitId);
      },
      buildApp: chunkPlacement.restoreOutputFileNames,
      load: loading.loadForBuild,
      generateBundle(
        _outputOptions: NormalizedOutputOptionsLike,
        bundle: BundleLike,
        _isWrite: boolean
      ) {
        for (const [fileName, fallbacks] of findEagerFallbacksInSharedChunk(bundle)) {
          mfWarn(
            `A shared-dependency fallback was merged into the loadShare chunk ${fileName}: ` +
              `${fallbacks.join(', ')}.\n` +
              '  That fallback is no longer lazy, so consumers download their local copy even when a peer ' +
              'provides the share, and the container can deadlock.\n' +
              '  Stop the shared module from statically importing another share.'
          );
        }

        for (const [fileName, chunk] of Object.entries(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!isFederationControlChunk(fileName, filename)) continue;

          chunk.code = sanitizeFederationControlChunk(chunk.code, fileName, filename);
        }

        // Break transitive proxy deadlock.
        //
        // Rollup's CJS plugin creates commonjs-proxy wrapper chunks for
        // loadShare modules. These proxies share CJS helpers
        // (getDefaultExportFromCjs, getAugmentedNamespace) with prebuild
        // chunks (react, react-dom). This creates a transitive dependency:
        //   prebuild chunk -> commonjs-proxy -> loadShare chunk
        // When get() dynamically imports the prebuild chunk during
        // loadShare execution, it blocks on itself, causing deadlock.
        //
        // Fix: extract helper functions from commonjs-proxy chunks and
        // inline them in consuming chunks, then remove the proxy imports.
        const proxyChunks = collectLoadShareProxyChunks(bundle, LOAD_SHARE_TAG);
        if (proxyChunks.size > 0) {
          const systemProxyInfo = collectSystemProxyInfos(proxyChunks, LOAD_SHARE_TAG);

          // Extract helper functions from each proxy chunk.
          // Proxy chunks export: standalone helpers + wrapped loadShare namespace.
          // We only inline the standalone helpers; namespace deps are redirected.
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (!isOutputChunk(chunk)) continue;
            if (proxyChunks.has(fileName)) continue;

            let code = chunk.code;
            if (!fileName.includes(LOAD_SHARE_TAG)) {
              code = rewriteEsmProxyConsumers(code, proxyChunks);
            }

            code = rewriteSystemProxyConsumers(code, systemProxyInfo);

            if (code !== chunk.code) {
              chunk.code = code;
            }
          }
        }
      },
    },
    {
      name: 'module-federation-strip-empty-preload-helper',
      enforce: 'post' as const,
      apply: 'build' as const,
      renderChunk(code: string, chunk: RenderedChunkLike) {
        if (!isFederationControlChunk(chunk.fileName, filename)) return;

        const nextCode = sanitizeFederationControlChunk(code, chunk.fileName, filename);

        return nextCode === code ? null : { code: nextCode, map: null };
      },
      writeBundle(outputOptions: NormalizedOutputOptionsLike, bundle: BundleLike) {
        if (!outputOptions.dir) return;

        for (const chunk of Object.values(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!isFederationControlChunk(chunk.fileName, filename)) continue;

          const outputPath = path.join(outputOptions.dir, chunk.fileName);
          const nextCode = sanitizeFederationControlChunk(
            readFileSync(outputPath, 'utf-8'),
            chunk.fileName,
            filename
          );

          writeFileSync(outputPath, nextCode);
        }
      },
    },
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // used to expose plugin options: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config: UserConfig, { command: _command }: ConfigEnv) {
        const isRolldown = getIsRolldown(this);
        loading.configureSsrBuild(config, _command);
        const needsRuntimeHelpers = hasShared(options);

        if (needsRuntimeHelpers) {
          appendResolveAlias(config, {
            find: /^@module-federation\/runtime\/helpers$/,
            replacement: getRuntimeHelpersImplementation(options.implementation),
          });
        }

        appendResolveAlias(config, {
          find: /^@module-federation\/runtime$/,
          replacement: options.implementation,
        });
        config.build ||= {};
        config.build.commonjsOptions ||= {};
        config.build.commonjsOptions.strictRequires ??= 'auto';
        dependencies.includeRuntimeDependencies(config, needsRuntimeHelpers);

        if (isRolldown) {
          // Vite 8+: virtual modules use ESM.
          config.build ??= {};
          config.build.target ??= 'esnext';
        }

        const isAstro = hasPackageDependency('astro');
        // Resolve target: explicit option > SSR detection > 'web'
        // (Environment API server/ssr targets are set in configEnvironment.)
        const resolvedTarget = options.target ?? (config.build?.ssr ? 'node' : 'web');

        if (!config.define) config.define = {};
        applyBuildTimeRuntimeDefines(config.define, options, {
          target: resolvedTarget,
          isAstro,
          defaultDisableSnapshot: resolvedTarget === 'node' ? true : undefined,
        });

        for (const warning of getRuntimeCapabilityConfigurationWarnings(options)) {
          if (emittedRuntimeCapabilityWarnings.has(warning)) continue;
          emittedRuntimeCapabilityWarnings.add(warning);
          mfWarn(warning);
        }
      },
      configResolved(config: ResolvedConfig) {
        // TanStack Start/Nitro performs its server build from a deferred
        // closeBundle task. Some example integrations add a build-exit hook
        // that calls process.exit() immediately, which aborts that task after
        // the client build and leaves .output/server/index.mjs missing.
        // Disable only that explicitly named workaround; other exit hooks and
        // non-Nitro projects remain untouched.
        if (!hasPackageDependency('nitro')) return;
        const prematureExit = config.plugins.find(
          (plugin) => plugin.name === 'tanstack-build-exit'
        );
        if (prematureExit) {
          prematureExit.closeBundle = undefined;
        }
      },
      configEnvironment(name: string, config: EnvironmentOptions) {
        // Client graphs keep ENV_TARGET from root config(); only server/ssr envs need node.
        if (!isServerEnvironment(name, config)) return;

        const isAstro = hasPackageDependency('astro');
        // Copy define per environment — Vite may reuse the same object across envs.
        config.define = { ...(config.define ?? {}) };
        applyBuildTimeRuntimeDefines(config.define, options, {
          target: options.target ?? 'node',
          isAstro,
          defaultDisableSnapshot: true,
        });
      },
    },
    ...pluginManifest(options),
    ...pluginSSRRemoteEntry(options),
    ...pluginVarRemoteEntry(options),
    {
      name: 'module-federation-vinext-fix-rsc-preload-as',
      enforce: 'post' as const,
      configureServer(server) {
        if (!hasPackageDependency('vinext')) return;

        server.middlewares.use((req, res, next) => {
          if (!req.headers.accept?.includes('text/html')) {
            next();
            return;
          }

          const chunks: Buffer[] = [];
          const end = res.end.bind(res);

          res.write = (chunk: any) => {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return true;
          };

          res.end = (chunk: any, ...args: any[]) => {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = normalizeVinextRscPreloadHints(Buffer.concat(chunks).toString());
            return end(body, ...args);
          };

          next();
        });
      },
      generateBundle(_: NormalizedOutputOptionsLike, bundle: BundleLike, _isWrite: boolean) {
        if (!hasPackageDependency('vinext')) return;

        for (const chunk of Object.values(bundle)) {
          if (!isOutputChunk(chunk)) continue;
          if (!chunk.code.includes('case"L"')) continue;

          chunk.code = chunk.code.replace(
            /case"L":(\w+)=(\w+)\[0\],(\w+)=\2\[1\],\2\.length===3\?(\w+)\.L\(\1,\3,\2\[2\]\):\4\.L\(\1,\3\)/g,
            'case"L":$1=$2[0],$3=$2[1],$3==="stylesheet"&&($3="style"),$2.length===3?$4.L($1,$3,$2[2]):$4.L($1,$3)'
          );
        }
      },
    } satisfies Plugin,
    // Fix preload helper for federated remotes: Vite's preload helper resolves
    // asset URLs against the page origin (e.g. host), but remote chunks need
    // to resolve against their own origin. Replace the hardcoded base URL
    // function with import.meta.url-based resolution.
    ...(function () {
      let disablePreload = false;

      return Object.keys(options.exposes).length > 0
        ? [
            {
              name: 'module-federation-fix-preload',
              enforce: 'post' as const,
              apply: 'build' as const,
              config(_config, { command }) {
                const manifest = options.manifest;
                const getDefaultDisableAssetsAnalyze = (cfgCommand: string | undefined) =>
                  cfgCommand === 'serve' &&
                  (typeof manifest !== 'object' ||
                    !Object.hasOwn(manifest, 'disableAssetsAnalyze'));

                const getConfiguredDisableAssetsAnalyze = (cfgCommand: string | undefined) => {
                  if (typeof manifest === 'object' && manifest !== null) {
                    if (Object.hasOwn(manifest, 'disableAssetsAnalyze')) {
                      return manifest.disableAssetsAnalyze === true;
                    }
                  }

                  return getDefaultDisableAssetsAnalyze(cfgCommand);
                };

                disablePreload = getConfiguredDisableAssetsAnalyze(command);
              },
              generateBundle(
                _outputOptions: NormalizedOutputOptionsLike,
                bundle: BundleLike,
                _isWrite: boolean
              ) {
                if (disablePreload) return;

                for (const chunk of Object.values(bundle)) {
                  if (!isOutputChunk(chunk)) continue;
                  if (!chunk.code.includes('modulepreload')) continue;
                  const chunkDir = path.dirname(chunk.fileName);
                  const prefixToRoot =
                    chunkDir === '.'
                      ? ''
                      : `${normalizePathForImport(path.relative(chunkDir, '.'))}/`;
                  const replacementExpr = prefixToRoot
                    ? `${escapeUnsafeJsSourceChars(JSON.stringify(prefixToRoot))}+$1`
                    : '$1';
                  // Match Vite's preload helper asset URL function across minifiers:
                  //   Vite 8+:  t=function(e){return`/`+e}
                  //   esbuild (Vite 5-7): const o=e=>"/"+e  or  o=function(e){return"/"+e}
                  //   terser:             o=function(e,t){return'/'+e}
                  // Replace with import.meta.url-based resolution so assets
                  // resolve against the module's own origin, not the page origin.
                  const replacement = `=function($1){return new URL(${replacementExpr},import.meta.url).href}`;
                  // Arrow function: e=>"/"+e or (e)=>"/"+e or (e,t)=>"/"+e
                  // The string literal must start with "/" to avoid matching unrelated
                  // functions like Stencil's getScopeId: (e,t)=>"sc-"+e.$tagName$
                  const replaced = chunk.code.replace(
                    /=\s*\(?(\w+)(?:,\w+)?\)?\s*=>\s*[`"'][./][^`"']*[`"']\s*\+\s*\1/,
                    replacement
                  );
                  if (replaced !== chunk.code) {
                    chunk.code = replaced;
                    continue;
                  }
                  // Function expression: function(e){return"/"+e} (1 or 2 params)
                  chunk.code = chunk.code.replace(
                    /=\s*function\((\w+)(?:,\w+)?\)\s*\{\s*return\s*[`"'][./][^`"']*[`"']\s*\+\s*\1;?\s*\}/,
                    replacement
                  );
                  chunk.code = chunk.code.replace(
                    /=function\((\w+)(?:,\w+)?\)\{return new URL\("\.\.\/"\+\1,import\.meta\.url\)\.href\}/,
                    replacement
                  );
                  chunk.code = chunk.code.replace(
                    /new URL\("\.\.\/"\+(\w+),import\.meta\.url\)\.href/g,
                    `new URL(${replacementExpr},import.meta.url).href`
                  );
                }
              },
            } satisfies Plugin,
          ]
        : [];
    })(),
  ];
}

function createModuleFederationConfig<T extends ModuleFederationOptions>(options: T): T {
  return options;
}

export {
  createModuleFederationConfig,
  federation,
  type ModuleFederationOptions,
  type PluginExperimentsOptions,
  type PluginManifestOptions,
  type SsrEntryLoaderConfig,
  type SsrEntryLoaderStrategy,
  type TreeShakingConfig,
};
