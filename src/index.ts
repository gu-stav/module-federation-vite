import { existsSync } from 'fs';
import { createRequire } from 'module';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'url';
import type {
  Alias,
  ConfigEnv,
  EnvironmentOptions,
  Plugin,
  ResolvedConfig,
  UserConfig,
} from 'vite';
import { version as viteVersion } from 'vite';
import { createVirtualModuleLoading } from './virtualModuleLoading';
import { createDependencyPreparation } from './dependencyPreparation';
import { createChunkPlacement } from './chunkPlacement';
import { createChunkCleanup } from './chunkCleanup';
import { scanEntryImports } from './entryScan';
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
  collectSystemProxyExports,
  isOutputChunk,
  rewriteEsmProxyConsumers,
  rewriteSystemProxyConsumers,
  type Bundle,
} from './utils/bundleHelpers';
import { normalizePathForImport } from './utils/buildPaths';
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
  getHostAutoInitPath,
  getRemoteEntryId,
  initVirtualModules,
  LOAD_SHARE_TAG,
  writeLocalSharedImportMap,
} from './virtualModules';
import { getVirtualExposesId } from './virtualModules/virtualExposes';
import { addUsedShares } from './virtualModules/virtualRemoteEntry';
import { ensureUsedRemote } from './virtualModules/virtualRemotes';
import { getRuntimeInitStatusImportId } from './virtualModules/virtualRuntimeInitStatus';
import { findEagerFallbacksInSharedChunk } from './virtualModules/loadShareSharedChunk';
import { resetConcreteSharedImportSourceCache } from './virtualModules/virtualShared_preBuild';

// Accept legacy boolean watch settings as well as Vite's current options.
type ViteWatchConfig = NonNullable<UserConfig['server']>['watch'] | boolean;

function normalizeVinextRscPreloadHints(code: string): string {
  return code
    .replace(/(:HL\[[^\]\n]*?,)"stylesheet"/g, '$1"style"')
    .replace(/(:HL\[[^\]\n]*?,)\\"stylesheet\\"/g, '$1\\"style\\"');
}

function ignoreGeneratedFiles(
  config: { server?: { watch?: ViteWatchConfig } },
  options: NormalizedModuleFederationOptions
): void {
  config.server ??= {};
  const watch = config.server.watch;

  if (watch === false || watch === null) {
    return;
  }

  const watchOptions = watch === true || watch === undefined ? {} : watch;
  config.server.watch = watchOptions;

  const ignoreFile = (file: string) => shouldIgnoreFile(file, options);
  const ignored = watchOptions.ignored;
  if (!ignored) {
    watchOptions.ignored = ignoreFile;
    return;
  }
  if (Array.isArray(ignored)) {
    ignored.push(ignoreFile);
    return;
  }
  watchOptions.ignored = [ignored, ignoreFile];
}

type NormalizedOutputOptionsLike = { dir?: string };

function appendResolveAlias(config: UserConfig, alias: Alias): void {
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

// Capture the runtime directory and extension to find its helpers module.
const RUNTIME_INDEX_ENTRY_RE = /^(.*[\\/])index(\.[cm]?js)$/;
const TRAILING_SLASH_RE = /\/$/;

function getRuntimeHelpersImport(runtimeImplementation: string): string {
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

function escapeUnsafeJavaScriptCharacters(str: string): string {
  return str.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, (char) => {
    return UNSAFE_JS_SOURCE_CHAR_MAP[char] ?? char;
  });
}

function isRuntimePreloadDependency(dep: string, includeSharedRuntime = false): boolean {
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

// React Router adds ?__react-router-build-client-route entries that have no source
// file. Skip them when scanning imports.
function isReactRouterBuildClientRouteInput(entry: string): boolean {
  return /[?&]__react-router-build-client-route(?:[=&]|$)/.test(entry);
}

type JsxTransformOptions = {
  jsx?: string | boolean | { runtime?: string; importSource?: string; development?: boolean };
  jsxImportSource?: string;
  jsxDev?: boolean;
};

function getAutomaticJsxRuntime(config: ResolvedConfig): string | undefined {
  for (const candidate of [config.oxc, config.esbuild]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const transform: JsxTransformOptions = candidate;
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

// JSX compilation adds an import after the source scan. Register the JSX runtime
// and its shared package even when Vite reuses cached optimized dependencies.
function registerJsxRuntimeImports(
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
 * Registers virtual modules in the config hook before dependency optimization.
 * This prevents 504 "Outdated Optimize Dep" errors from modules registered too late.
 */
function createEarlyVirtualModulesPlugin(
  options: NormalizedModuleFederationOptions,
  dependencySetup: ReturnType<typeof createDependencyPreparation>
): Plugin {
  const { shared, remotes } = options;
  let hasClientJsxFiles = false;
  return {
    name: 'vite:module-federation-early-init',
    enforce: 'pre',
    config(config: UserConfig, { command }) {
      if (command === 'serve') ignoreGeneratedFiles(config, options);

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
      const resolvedEntryFiles = configuredEntryFiles
        .map((entry) => String(entry))
        .filter((entry) => !isReactRouterBuildClientRouteInput(entry))
        .map((entry) => entry.split(/[?#]/)[0])
        .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(root, entry)));
      resetConcreteSharedImportSourceCache();
      setPackageDetectionCwd(root);
      resolveSharedVersions(shared, root);
      const isVinext = hasPackageDependency('vinext');

      // Register the runtime and remote entry virtual modules.
      initVirtualModules(command, getRemoteEntryId(options), false, options);

      const isRolldown = getIsRolldown(this);

      // A build can load remoteEntry before resolving the application's imports.
      // Register remote aliases now so localSharedImportMap includes them.
      // Register individual exposed modules when the application imports them.
      if (remotes && Object.keys(remotes).length > 0) {
        for (const key of Object.keys(remotes)) {
          ensureUsedRemote(key, options);
        }
        dependencySetup.excludeRemotesFromOptimization(config, command);
      }

      if (!config.build?.ssr && (hasShared(options) || hasRemotes(options))) {
        // Scan static remote imports during builds too, so host initialization
        // waits for the remote modules needed at startup. Register shared imports
        // only in the dev server, where they affect dependency optimization.
        const hasJsxFiles = scanEntryImports(
          config,
          options,
          root,
          command === 'serve',
          resolvedEntryFiles
        );
        if (command === 'serve') hasClientJsxFiles = hasJsxFiles;
      }

      dependencySetup.prepareSharedDependencies(config, {
        root,
        command,
        isRolldown,
        isVinext,
      });
    },

    configResolved(config) {
      if (hasClientJsxFiles) {
        const automaticJsxRuntime = getAutomaticJsxRuntime(config);
        if (automaticJsxRuntime && registerJsxRuntimeImports(options, automaticJsxRuntime)) {
          writeLocalSharedImportMap(options);
        }
      }

      const viteMajor = parseInt(viteVersion, 10);
      const ssrCapabilities = getSsrCapabilities(
        viteMajor,
        config.command,
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
            // ssrEntryLoader will try resolving the package from the host at runtime.
          }
        }
      }

      // Add ssrEntryLoader only when its built file exists in lib/.
      // Tests using src/ may run before a build. runtimePlugins still allows
      // applications to configure the loader themselves.
      const ssrLoaderImport = SSR_ENTRY_LOADER_SPECIFIER;
      try {
        resolveImportPath(ssrLoaderImport);
        options.runtimePlugins.push([
          ssrLoaderImport,
          {
            resolvedShared,
            ...(options.ssrEntryLoader?.strategy
              ? { strategy: options.ssrEntryLoader.strategy }
              : {}),
          },
        ]);
      } catch {
        // The loader has not been built yet.
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
    // Before lib/ is built, resolve the source file beside this module.
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
  const virtualModules = createVirtualModuleLoading(options, remoteEntryId, virtualExposesId);
  const chunkPlacement = createChunkPlacement(options);
  const chunkCleanup = createChunkCleanup(filename);
  const dependencySetup = createDependencyPreparation(options);
  const emittedRuntimeCapabilityWarnings = new Set<string>();

  return [
    virtualModules.loaderPlugin,
    ...(options.experiments.externalRuntime ? [pluginExternalRuntimeCore()] : []),
    // Register virtual modules before Vite optimizes dependencies.
    createEarlyVirtualModulesPlugin(options, dependencySetup),
    ...(isVinext
      ? [
          {
            name: 'module-federation-vinext-react-server-build-alias',
            apply: 'build',
            enforce: 'pre',
            resolveId(id) {
              const reactServerEntryMap: Record<string, string> = {
                'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
                'react/jsx-dev-runtime': 'react/cjs/react-jsx-dev-runtime.production.js',
                'react/compiler-runtime': 'react/cjs/react-compiler-runtime.production.js',
              };
              if (!(id in reactServerEntryMap)) return;
              const environmentName = this.environment?.name;
              if (!environmentName || environmentName === 'client') return;

              const target = reactServerEntryMap[id];
              const projectRequire = createRequire(
                pathToFileURL(path.join(process.cwd(), 'package.json'))
              );
              const reactPackageJson = projectRequire.resolve('react/package.json');
              return path.join(path.dirname(reactPackageJson), target.replace(/^react\//, ''));
            },
          } satisfies Plugin,
        ]
      : []),
    virtualModules.initializationPlugin,
    aliasToArrayPlugin,
    checkAliasConflicts({ shared }),
    dependencySetup.optimizeDepsPlugin,
    ...loadPluginDts(options),
    pluginDevRemoteHmr(options),
    {
      // Frameworks such as TanStack Start expect one application entry chunk.
      // Clear isEntry on generated chunks such as hostInit and remoteEntry before
      // framework plugins inspect the bundle.
      name: 'mf:normalize-entry-chunks',
      enforce: 'pre',
      apply: 'build',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (
            typeof chunk !== 'object' ||
            chunk === null ||
            chunk.type !== 'chunk' ||
            !chunk.isEntry
          )
            continue;
          const facadeId = chunk.facadeModuleId ?? '';
          if (
            facadeId.includes('__mf__virtual') ||
            facadeId.startsWith('virtual:mf-') ||
            facadeId.startsWith('virtual:mf:') ||
            facadeId.startsWith('\0virtual:mf-') ||
            facadeId.startsWith('\0virtual:mf:')
          ) {
            chunk.isEntry = false;
          }
        }
      },
    } satisfies Plugin,
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
      getParsePromise: virtualModules.getImportAnalysisPromise,
    }),
    pluginProxyRemotes(options),
    pluginRemoteNamedExports(options),
    ...virtualModules.importAnalysisPlugins,
    ...proxySharedModule({
      shared,
      federationOptions: options,
      getParsePromise: virtualModules.getImportAnalysisPromise,
    }),
    pluginLazyConsumeOnlyShares(options),
    {
      name: 'module-federation-esm-shims',
      enforce: 'pre',
      apply: 'build',
      config(config: UserConfig) {
        virtualModules.configureSsrBuild(config);
        const runtimeInitId = getRuntimeInitStatusImportId(options);
        config.build = config.build || {};

        if (config.build.modulePreload !== false) {
          // Match emitted filenames after [hash] is replaced and .js is added.
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
            resolveDependencies(filename, deps, context) {
              const resolvedDeps = existingResolveDependencies
                ? existingResolveDependencies(filename, deps, context)
                : deps;
              const hostFile = path.basename(context.hostId);
              const skipRuntimePreloads =
                context.hostType === 'js' &&
                (isRemoteEntryFile(hostFile) ||
                  hostFile.includes('hostInit') ||
                  hostFile.includes('localSharedImportMap'));

              if (skipRuntimePreloads) return [];

              const hasRuntimeDeps =
                (context.hostType === 'html' || context.hostType === 'js') &&
                resolvedDeps.some((dep) => isRuntimePreloadDependency(dep));

              const isTreeShakingFallback = hasTreeShakingShared
                ? (dep: string) => dep.includes('__prebuild__')
                : () => false;

              return hasRuntimeDeps
                ? resolvedDeps.filter(
                    (dep) => !isRuntimePreloadDependency(dep, true) && !isTreeShakingFallback(dep)
                  )
                : resolvedDeps.filter((dep) => !isTreeShakingFallback(dep));
            },
          };
        }

        chunkPlacement.configureBuildOutputs(config.build, runtimeInitId);
      },
      buildApp: chunkPlacement.restoreOutputFileNames,
      load: virtualModules.loadForBuild,
      generateBundle(
        _outputOptions: NormalizedOutputOptionsLike,
        bundle: Bundle,
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

        chunkCleanup.cleanBundle(bundle);

        // Rollup's CommonJS helpers can make a local fallback import a proxy that
        // imports loadShare. If loadShare is waiting for that fallback, neither
        // can finish loading. Copy the helper functions into importing chunks
        // and remove their proxy imports to break the circular dependency.
        const proxyChunks = collectLoadShareProxyChunks(bundle, LOAD_SHARE_TAG);
        if (proxyChunks.size > 0) {
          const systemProxyExports = collectSystemProxyExports(proxyChunks, LOAD_SHARE_TAG);

          // Copy helper functions; keep module imports pointing to loadShare.
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (!isOutputChunk(chunk)) continue;
            if (proxyChunks.has(fileName)) continue;

            let code = chunk.code;
            if (!fileName.includes(LOAD_SHARE_TAG)) {
              code = rewriteEsmProxyConsumers(code, proxyChunks);
            }

            code = rewriteSystemProxyConsumers(code, systemProxyExports);

            if (code !== chunk.code) {
              chunk.code = code;
            }
          }
        }
      },
    },
    chunkCleanup.plugin,
    {
      name: 'module-federation-vite',
      enforce: 'post',
      // Expose options to other plugins: https://github.com/rolldown/rolldown/discussions/2577#discussioncomment-11137593
      _options: options,
      config(config: UserConfig, { command }: ConfigEnv) {
        const isRolldown = getIsRolldown(this);
        virtualModules.configureSsrBuild(config, command);
        const needsRuntimeHelpers = hasShared(options);

        if (needsRuntimeHelpers) {
          appendResolveAlias(config, {
            find: /^@module-federation\/runtime\/helpers$/,
            replacement: getRuntimeHelpersImport(options.implementation),
          });
        }

        appendResolveAlias(config, {
          find: /^@module-federation\/runtime$/,
          replacement: options.implementation,
        });
        config.build ||= {};
        config.build.commonjsOptions ||= {};
        config.build.commonjsOptions.strictRequires ??= 'auto';
        dependencySetup.includeRuntimeDependencies(config, needsRuntimeHelpers);

        if (isRolldown) {
          // Vite 8+: virtual modules use ESM.
          config.build ??= {};
          config.build.target ??= 'esnext';
        }

        const isAstro = hasPackageDependency('astro');
        // Use the configured target, or infer it from build.ssr.
        // configEnvironment handles Vite's separate server environments.
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
        // Nitro starts its server build in closeBundle. Disable the example's
        // tanstack-build-exit hook so it cannot exit after the client build,
        // before .output/server/index.mjs is written.
        if (!hasPackageDependency('nitro')) return;
        const prematureExit = config.plugins.find(
          (plugin) => plugin.name === 'tanstack-build-exit'
        );
        if (prematureExit) {
          prematureExit.closeBundle = undefined;
        }
      },
      configEnvironment(name: string, config: EnvironmentOptions) {
        // Server environments need ENV_TARGET=node; clients use the root config value.
        if (!isServerEnvironment(name, config)) return;

        const isAstro = hasPackageDependency('astro');
        // Copy define because Vite may share this object between environments.
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
      enforce: 'post',
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
      generateBundle(_: NormalizedOutputOptionsLike, bundle: Bundle, _isWrite: boolean) {
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
    // Resolve remote asset URLs relative to the remote module's import.meta.url,
    // rather than the host page's URL.
    ...(function () {
      let skipPreloadRewrite = false;

      return Object.keys(options.exposes).length > 0
        ? [
            {
              name: 'module-federation-fix-preload',
              enforce: 'post',
              apply: 'build',
              config(_config, { command }) {
                const manifest = options.manifest;
                skipPreloadRewrite =
                  typeof manifest === 'object' &&
                  manifest !== null &&
                  Object.hasOwn(manifest, 'disableAssetsAnalyze')
                    ? manifest.disableAssetsAnalyze === true
                    : command === 'serve' &&
                      (typeof manifest !== 'object' ||
                        !Object.hasOwn(manifest, 'disableAssetsAnalyze'));
              },
              generateBundle(
                _outputOptions: NormalizedOutputOptionsLike,
                bundle: Bundle,
                _isWrite: boolean
              ) {
                if (skipPreloadRewrite) return;

                for (const chunk of Object.values(bundle)) {
                  if (!isOutputChunk(chunk)) continue;
                  if (!chunk.code.includes('modulepreload')) continue;
                  const chunkDir = path.dirname(chunk.fileName);
                  const prefixToRoot =
                    chunkDir === '.'
                      ? ''
                      : `${normalizePathForImport(path.relative(chunkDir, '.'))}/`;
                  const replacementExpr = prefixToRoot
                    ? `${escapeUnsafeJavaScriptCharacters(JSON.stringify(prefixToRoot))}+$1`
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
