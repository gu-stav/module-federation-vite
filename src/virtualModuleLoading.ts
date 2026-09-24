import type { ConfigEnv, HookHandler, Plugin, SSRTarget, UserConfig } from 'vite';
import { version as viteVersion } from 'vite';
import pluginModuleParseEnd, { createModuleParseController } from './plugins/pluginModuleParseEnd';
import { mfWarn } from './utils/logger';
import {
  resolveSharedVersions,
  type NormalizedModuleFederationOptions,
} from './utils/normalizeModuleFederationOptions';
import { getIsRolldown, resolveImportPath } from './utils/packageUtils';
import { resolveEnvironmentConsumerTarget } from './utils/remoteConsumerTarget';
import { getSharedExportConditions } from './utils/sharedExportConditions';
import { findSharedKey } from './utils/sharedKeyMatcher';
import {
  getSsrCapabilities,
  isServerEnvironment,
  isSsrConfig,
  SSR_ENTRY_LOADER_SPECIFIER,
} from './utils/ssrCapabilities';
import { getSharedExportUsage, type TreeShakingExportUsage } from './utils/treeShaking';
import VirtualModule from './utils/VirtualModule';
import {
  getHostAutoInitPath,
  getPendingSharesPath,
  isOwnedPendingSharesId,
  PENDING_SHARES_TAG,
  refreshPendingShares,
  initVirtualModules,
  LOAD_REMOTE_TAG,
  LOAD_SHARE_TAG,
  PREBUILD_TAG,
  refreshRemoteModuleForEnvironment,
  REMOTE_ENTRY_ID,
  TREE_SHAKING_GRAPH_QUERY,
  TREE_SHAKING_PROVIDER_TAG,
  writeLocalSharedImportMap,
} from './virtualModules';
import {
  addUsedShares,
  HOST_AUTO_INIT_TAG,
  isOwnedHostAutoInitId,
  refreshHostAutoInit,
} from './virtualModules/virtualRemoteEntry';
import {
  findCurrentLoadShareForStaleOwnerId,
  getCachedLoadSharePkg,
  getCachedPreBuildPkg,
  getLoadShareModulePath,
  getPreBuildLibImportId,
  invalidateSharedExportInspectionCache,
  markLoadShareWrapperNotCoalescable,
  materializeCachedLoadShareModule,
  prependWorkspaceSingletonSsrImport,
  writeLoadShareModule,
  writePreBuildLibPath,
} from './virtualModules/virtualShared_preBuild';

type LoadHook = HookHandler<NonNullable<Plugin['load']>>;
type LoadHookContext = ThisParameterType<LoadHook>;
type LoadHookOptions = Parameters<LoadHook>[1];

/**
 * Resolves and loads virtual modules for one plugin instance. The Vite hooks share
 * the instance checks, export conditions, and promise for completing import analysis.
 */
export function createVirtualModuleLoading(
  options: NormalizedModuleFederationOptions,
  remoteEntryId: string,
  virtualExposesId: string
) {
  const { shared } = options;
  const importAnalysis = createModuleParseController();
  const importAnalysisPlugins = pluginModuleParseEnd(
    (id: string) => {
      return (
        id.includes(getHostAutoInitPath(options)) ||
        id.includes(getPendingSharesPath(options)) ||
        id.includes(REMOTE_ENTRY_ID) ||
        id.includes(virtualExposesId) ||
        id.includes('virtual:mf-localSharedImportMap') ||
        id.includes(LOAD_SHARE_TAG) ||
        id.includes(PREBUILD_TAG) ||
        id.includes(TREE_SHAKING_PROVIDER_TAG) ||
        id.includes(TREE_SHAKING_GRAPH_QUERY)
      );
    },
    {
      moduleParseTimeout: options.moduleParseTimeout,
      moduleParseIdleTimeout: options.moduleParseIdleTimeout,
      exposedModuleImports: Object.values(options.exposes).map((expose) => expose.import),
    },
    importAnalysis
  );

  let command: ConfigEnv['command'];
  let isSsrBuild = false;
  let isProduction = false;
  let rootResolveConditions: string[] | undefined;
  let ssrResolveConditions: string[] | undefined;
  let ssrTarget: SSRTarget = 'node';

  const getExportConditions = (context: LoadHookContext, loadOptions?: LoadHookOptions) => {
    const environment = context.environment;
    const isSsr =
      loadOptions?.ssr === true ||
      isSsrBuild ||
      isServerEnvironment(environment?.name, environment?.config);
    return getSharedExportConditions({
      environmentConditions: environment?.config?.resolve?.conditions,
      isProduction: environment?.config?.isProduction ?? isProduction,
      isSsr,
      rootConditions: rootResolveConditions,
      ssrConditions: ssrResolveConditions,
      ssrTarget,
    });
  };

  const refreshRemoteModule = (
    id: string,
    context: LoadHookContext,
    loadOptions?: LoadHookOptions
  ) => refreshRemoteModuleForEnvironment(id, options, getExportConditions(context, loadOptions));

  // Check which plugin instance created the module before regenerating its code.
  // Leave unknown IDs for later load hooks; reject IDs belonging to another instance.
  const refreshSharedModule = (
    id: string,
    kind: 'prebuild' | 'loadShare',
    context: LoadHookContext,
    loadOptions?: LoadHookOptions,
    exportUsage?: TreeShakingExportUsage
  ): boolean => {
    const packageName = kind === 'prebuild' ? getCachedPreBuildPkg(id) : getCachedLoadSharePkg(id);
    if (!packageName) return true;
    const sharedKey = findSharedKey(packageName, shared);
    if (!sharedKey) return true;
    const requestedVirtualModule = VirtualModule.findById(id);
    const instanceModuleId =
      kind === 'prebuild'
        ? getPreBuildLibImportId(packageName, options)
        : getLoadShareModulePath(packageName, false, options);
    if (
      !requestedVirtualModule ||
      requestedVirtualModule !== VirtualModule.findById(instanceModuleId)
    )
      return false;
    if (kind === 'prebuild') {
      writePreBuildLibPath(
        packageName,
        shared[sharedKey],
        options,
        getExportConditions(context, loadOptions)
      );
    } else {
      writeLoadShareModule(
        packageName,
        shared[sharedKey],
        command,
        getIsRolldown(context),
        options,
        getExportConditions(context, loadOptions),
        exportUsage
      );
    }
    return true;
  };

  const waitForSharedExportUsage = (id: string) => {
    if (command !== 'build') return undefined;
    const packageName = getCachedLoadSharePkg(id);
    if (!packageName) return undefined;
    const sharedKey = findSharedKey(packageName, shared);
    if (!sharedKey || shared[sharedKey].shareConfig.import !== false) return undefined;

    return importAnalysis.parsePromise.then((completion) => {
      if (!completion.complete) {
        // Explain why an incomplete import analysis keeps all named exports.
        if (!importAnalysis.discardWarned) {
          importAnalysis.discardWarned = true;
          mfWarn(
            `import: false shared export analysis was discarded (reason: ${completion.reason})` +
              ' — falling back to the complete export surface, so shared consumers keep every' +
              ' detected named export.' +
              (completion.reason === 'idle-timeout' || completion.reason === 'timeout'
                ? ' If the build is simply slow, increasing moduleParseIdleTimeout may let the analysis finish.'
                : '')
          );
        }
        return undefined;
      }
      return getSharedExportUsage(packageName, shared[sharedKey], sharedKey, options);
    });
  };

  return {
    loaderPlugin: {
      name: 'vite:module-federation-virtual-modules',
      enforce: 'pre',
      configureServer(server) {
        server.watcher.on('change', invalidateSharedExportInspectionCache);
        server.watcher.on('add', invalidateSharedExportInspectionCache);
        server.watcher.on('unlink', invalidateSharedExportInspectionCache);
      },
      resolveId(id) {
        if (id === SSR_ENTRY_LOADER_SPECIFIER) return resolveImportPath(id);
        let virtualModule = VirtualModule.findById(id);
        if (!virtualModule) {
          materializeCachedLoadShareModule({
            id,
            shared: options.shared,
            command,
            isRolldown: getIsRolldown(this),
            findSharedKey,
            addUsedShares: (packageName) => addUsedShares(packageName, options),
            writeLocalSharedImportMap: () => writeLocalSharedImportMap(options),
            federationOptions: options,
          });
          virtualModule =
            VirtualModule.findById(id) ??
            findCurrentLoadShareForStaleOwnerId(id, options.shared, findSharedKey, options);
        }
        if (!virtualModule) return;
        return virtualModule.getResolvedId();
      },
      load(id, loadOptions) {
        if (id.includes(LOAD_REMOTE_TAG) && !refreshRemoteModule(id, this, loadOptions)) {
          return;
        }
        if (command !== 'build' && id.includes(LOAD_SHARE_TAG)) {
          id =
            findCurrentLoadShareForStaleOwnerId(
              id,
              options.shared,
              findSharedKey,
              options
            )?.getResolvedId() ?? id;
          if (!refreshSharedModule(id, 'loadShare', this, loadOptions)) return;
        }
        if (id.includes(PREBUILD_TAG) && !refreshSharedModule(id, 'prebuild', this, loadOptions)) {
          return;
        }
        if (id.includes(HOST_AUTO_INIT_TAG) && isOwnedHostAutoInitId(id, options)) {
          refreshHostAutoInit(options, getExportConditions(this, loadOptions));
        }
        if (id.includes(PENDING_SHARES_TAG) && isOwnedPendingSharesId(id, options)) {
          refreshPendingShares(options);
        }
        const virtualModule = VirtualModule.findById(id);
        if (!virtualModule) return;
        if (command === 'build' && (id.includes(LOAD_SHARE_TAG) || id.includes(LOAD_REMOTE_TAG))) {
          return;
        }
        return virtualModule.code;
      },
    } satisfies Plugin,
    initializationPlugin: {
      name: 'vite:module-federation-config',
      enforce: 'pre',
      config(_config, env) {
        command = env.command;
      },
      configResolved(config) {
        rootResolveConditions = config.resolve?.conditions
          ? [...config.resolve.conditions]
          : undefined;
        ssrResolveConditions = config.ssr?.resolve?.conditions
          ? [...config.ssr.resolve.conditions]
          : undefined;
        ssrTarget = config.ssr?.target ?? 'node';
        isProduction = config.isProduction;
        const ssrCapabilities = getSsrCapabilities(
          parseInt(viteVersion, 10),
          command,
          Object.keys(options.remotes).length > 0,
          isSsrConfig(config)
        );
        resolveSharedVersions(shared, config.root);
        initVirtualModules(command, remoteEntryId, ssrCapabilities.enableSsrInitBootstrap, options);
      },
    } satisfies Plugin,
    importAnalysisPlugins,
    // buildStart replaces this promise. Read it when needed so each build uses the current one.
    getImportAnalysisPromise: () => importAnalysis.parsePromise,
    configureSsrBuild(config: UserConfig, command: ConfigEnv['command'] = 'build') {
      isSsrBuild = command === 'build' && Boolean(config.build?.ssr);
    },
    loadForBuild(this: LoadHookContext, id: string, loadOptions?: LoadHookOptions) {
      const commonJsProxySuffix = '?commonjs-proxy';
      if (id.includes(LOAD_SHARE_TAG) && id.endsWith(commonJsProxySuffix)) {
        const target = id.slice(id.startsWith('\0') ? 1 : 0, -commonJsProxySuffix.length);
        return `export { __moduleExports as default } from ${JSON.stringify(target)};`;
      }

      const loadBuildCode = (exportUsage?: TreeShakingExportUsage) => {
        if (!id.includes(LOAD_SHARE_TAG) && !id.includes(LOAD_REMOTE_TAG)) return;
        if (id.includes(LOAD_REMOTE_TAG) && !refreshRemoteModule(id, this, loadOptions)) {
          return;
        }
        if (
          id.includes(LOAD_SHARE_TAG) &&
          !refreshSharedModule(id, 'loadShare', this, loadOptions, exportUsage)
        ) {
          return;
        }
        const virtualModule = VirtualModule.findById(id);
        if (!virtualModule?.code) return null;
        let code = virtualModule.code;

        const consumerTarget = resolveEnvironmentConsumerTarget(this);
        // Vite 5–7 SSR builds lack this.environment. Use build.ssr to decide
        // whether to add the local fallback imports needed on the server.
        if (consumerTarget === 'server' || (!consumerTarget && isSsrBuild)) {
          const withSsrImport = prependWorkspaceSingletonSsrImport(code);
          if (withSsrImport !== code) {
            const packageName = getCachedLoadSharePkg(id);
            if (packageName) markLoadShareWrapperNotCoalescable(packageName, options, id);
            code = withSsrImport;
          }
        }

        // Keep local fallback modules out of the loadShare chunk. Otherwise,
        // localSharedImportMap.get() can import the chunk that is waiting for
        // get() to finish. Its dynamic import still loads the fallback separately.
        code = code.replace(/import\s+["'][^"']*__prebuild__[^"']*["']\s*;?/g, '');
        code = code.replace(/export\s+\*\s+from\s+["'][^"']*__prebuild__[^"']*["']\s*;?/g, '');

        /**
         * Expose the module namespace as __moduleExports so Rollup can resolve
         * named imports such as { useState }. Keep the default export separate:
         * import styled from '@emotion/styled' must return the .default function,
         * rather than the object containing all exports. Pointing
         * syntheticNamedExports at 'default' would break that distinction.
         *
         * @see https://rollupjs.org/plugin-development/#synthetic-named-exports
         */
        const hasModuleExports =
          /\b(?:var|let|const)\s+__moduleExports\b/.test(code) ||
          /\bexport\s+const\s+__moduleExports\b/.test(code) ||
          /\bexport\s*\{[^}]*__moduleExports/.test(code);

        if (!hasModuleExports) {
          const nextCode = code.replace(
            'export default exportModule',
            'export const __moduleExports = exportModule;\n' +
              'export default exportModule.__esModule ? exportModule.default : exportModule'
          );
          code =
            nextCode === code
              ? `${code}\nexport const __moduleExports = exportModule;\n`
              : nextCode;
        }
        // Rolldown lacks syntheticNamedExports. pluginRemoteNamedExports rewrites
        // named imports in the importing module instead.
        if (getIsRolldown(this)) {
          return { code };
        }
        return { code, syntheticNamedExports: '__moduleExports' };
      };

      const pendingExportUsage = id.includes(LOAD_SHARE_TAG)
        ? waitForSharedExportUsage(id)
        : undefined;
      if (pendingExportUsage) {
        return pendingExportUsage.then(loadBuildCode);
      }
      return loadBuildCode();
    },
  };
}
