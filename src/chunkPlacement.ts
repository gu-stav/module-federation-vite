import type { GetManualChunk, OutputOptions as RollupOutputOptions } from 'rollup';
import type { Rolldown, UserConfig } from 'vite';
import { mfWarn } from './utils/logger';
import type { NormalizedModuleFederationOptions } from './utils/normalizeModuleFederationOptions';
import { findSharedKey } from './utils/sharedKeyMatcher';
import { getSharedChunkName, isSharedCacheHelpersId } from './virtualModules/loadShareSharedChunk';
import { LOAD_SHARE_TAG } from './virtualModules/shareTags';
import {
  getCachedLoadSharePkg,
  isCoalescableLoadShareWrapper,
} from './virtualModules/virtualShared_preBuild';

// Each plugin instance must recognize callbacks installed by earlier instances.
const installedManualChunks = new WeakSet<Function>();
// Track the group objects so a user's group with the same name is kept.
const installedChunkGroups = new WeakSet<object>();

// Rolldown can put the preload helper in a loadShare chunk. Other loadShare chunks
// then import that chunk and can end up waiting for each other to initialize.
// Give the helper its own chunk with no imports or top-level await.
const PRELOAD_HELPER_CHUNK = 'vite-preload-helper';
// Matches Rolldown's injected helper module id (`\0vite/preload-helper.js`).
// Require `vite/` so this does not match an application module named preload-helper.
// The leading null character used for virtual module IDs is optional.
const PRELOAD_HELPER_TEST = /\0?vite\/preload-helper/;

// Rolldown uses the matching group with the highest priority. Keep plugin groups
// above user groups so runtimeInit, loadShare, and the preload helper stay separate.
const GROUP_PRIORITY = 1_000_000;
const USER_GROUP_MAX_PRIORITY = GROUP_PRIORITY - 1;

type OutputFileNames = Pick<
  Rolldown.OutputOptions,
  'entryFileNames' | 'chunkFileNames' | 'assetFileNames'
>;
// Both option sets can be present in Vite config, even when only one bundler runs.
type ChunkOutputOptions = OutputFileNames &
  Pick<RollupOutputOptions, 'manualChunks'> &
  Pick<Rolldown.OutputOptions, 'codeSplitting'>;
type ChunkBuildOptions = { output?: ChunkOutputOptions | ChunkOutputOptions[] };
// Vite does not expose getRolldownOptions in its public types.
type BuilderWithOutputOptions = {
  environments: Record<
    string,
    {
      getRolldownOptions?: () => ChunkBuildOptions | Promise<ChunkBuildOptions>;
    }
  >;
};

function getOutputConfigs(options: ChunkBuildOptions): ChunkOutputOptions[] {
  const output = (options.output ||= {});
  return Array.isArray(output) ? output : [output];
}

/**
 * Configures chunks and restores output filenames for one plugin instance.
 * loadShare waits for remoteEntry to resolve initPromise. Keeping runtimeInit
 * in a separate chunk lets remoteEntry run without waiting for loadShare.
 */
export function createChunkPlacement(options: NormalizedModuleFederationOptions) {
  const { shared } = options;
  let configuredOutputNames: OutputFileNames[] | undefined;

  return {
    // Create the runtimeInit virtual module before configuring module preloads.
    configureBuildOutputs(build: NonNullable<UserConfig['build']>, runtimeInitId: string) {
      // Warn once per config call, even when several outputs need the same change.
      let warnedAboutCodeSplitting = false;
      const enableCodeSplitting = (output: ChunkOutputOptions) => {
        if (output?.codeSplitting !== false) return;
        delete output.codeSplitting;
        if (warnedAboutCodeSplitting) return;
        warnedAboutCodeSplitting = true;
        mfWarn(
          'Ignoring `output.codeSplitting = false` because module federation requires chunk splitting.'
        );
      };

      // Replace only groups installed by this plugin.
      const isInstalledChunkGroup = (group: unknown): boolean =>
        typeof group === 'object' && group !== null && installedChunkGroups.has(group);

      let warnedAboutGroupPriority = false;
      // Keep user groups below the plugin's groups so they handle other modules.
      const limitUserGroupPriority = (
        group: Rolldown.CodeSplittingGroup
      ): Rolldown.CodeSplittingGroup => {
        if (typeof group?.priority !== 'number') return group;
        if (group.priority <= USER_GROUP_MAX_PRIORITY) return group;
        if (!warnedAboutGroupPriority) {
          warnedAboutGroupPriority = true;
          mfWarn(
            `Clamping \`output.codeSplitting.groups\` priority to ${USER_GROUP_MAX_PRIORITY} — ` +
              'module federation groups must keep the highest priority so shared dependency init ' +
              'wrappers stay isolated in their own chunks.'
          );
        }
        return { ...group, priority: USER_GROUP_MAX_PRIORITY };
      };

      let warnedAboutManualChunks = false;
      let warnedAboutObjectManualChunks = false;
      const applyRollupPlacement = (
        output: ChunkOutputOptions,
        getRuntimeChunkName: (id: string) => string | null,
        hasInstalledManualChunks: boolean
      ) => {
        // Rollup (Vite 5–7) uses manualChunks. Assign the plugin's modules first,
        // then call the user's function for other modules.
        if (hasInstalledManualChunks) return;
        const userManualChunks = output.manualChunks;
        if (
          userManualChunks &&
          typeof userManualChunks !== 'function' &&
          !warnedAboutObjectManualChunks
        ) {
          warnedAboutObjectManualChunks = true;
          mfWarn(
            'Ignoring the object form of `output.manualChunks` because module federation cannot ' +
              'safely compose with it. Use the function form instead: federation modules are claimed ' +
              'first and your function runs for everything else.'
          );
        }
        const manualChunks: GetManualChunk = (id, ...rest) => {
          if (PRELOAD_HELPER_TEST.test(id)) return PRELOAD_HELPER_CHUNK;
          const runtimeChunkName = getRuntimeChunkName(id);
          if (runtimeChunkName) return runtimeChunkName;
          if (typeof userManualChunks === 'function') {
            return userManualChunks(id, ...rest) ?? undefined;
          }
          return undefined;
        };
        installedManualChunks.add(manualChunks);
        output.manualChunks = manualChunks;
      };

      const applyRolldownPlacement = (
        output: ChunkOutputOptions,
        getRuntimeChunkName: (id: string) => string | null,
        hasInstalledManualChunks: boolean
      ) => {
        // Rolldown (Vite 8+) needs codeSplitting groups to move the preload helper.
        // Use `test` for that helper because it does not pass through `name()`.
        // Use `name()` for runtimeInit and loadShare, with user groups below both.
        if (output.manualChunks && !hasInstalledManualChunks && !warnedAboutManualChunks) {
          warnedAboutManualChunks = true;
          mfWarn(
            'Ignoring `output.manualChunks` for the Rolldown build because module federation manages ' +
              'chunking with `output.codeSplitting.groups`. Move your grouping there — user groups are ' +
              'kept below the federation groups.'
          );
        }
        const existingGroups =
          output.codeSplitting && typeof output.codeSplitting === 'object'
            ? output.codeSplitting.groups
            : undefined;
        const userGroups = Array.isArray(existingGroups)
          ? existingGroups
              .filter((group) => !isInstalledChunkGroup(group))
              .map(limitUserGroupPriority)
          : [];
        const preloadGroup = {
          name: PRELOAD_HELPER_CHUNK,
          test: PRELOAD_HELPER_TEST,
          priority: GROUP_PRIORITY + 1,
        };
        const runtimeGroup = { name: getRuntimeChunkName, priority: GROUP_PRIORITY };
        installedChunkGroups.add(preloadGroup);
        installedChunkGroups.add(runtimeGroup);
        const groups = [preloadGroup, runtimeGroup, ...userGroups];
        output.codeSplitting = {
          ...(typeof output.codeSplitting === 'object' ? output.codeSplitting : {}),
          groups,
        };
        delete output.manualChunks;
      };

      const configureChunkPlacement = (
        output: ChunkOutputOptions,
        bundler: 'rollup' | 'rolldown'
      ) => {
        enableCodeSplitting(output);
        const hasInstalledManualChunks =
          typeof output.manualChunks === 'function' &&
          installedManualChunks.has(output.manualChunks);
        const getRuntimeChunkName = function (id: string): string | null {
          // Keep runtimeInitStatus separate so remoteEntry can initialize shared dependencies.
          if (id.includes(runtimeInitId) || id.includes('__mf_v__runtimeInit__mf_v__')) {
            return 'runtimeInit';
          }
          if (isSharedCacheHelpersId(id)) return getSharedChunkName(id);
          if (id.includes(LOAD_SHARE_TAG)) {
            const packageName = getCachedLoadSharePkg(id);
            const sharedKey = packageName && findSharedKey(packageName, shared);
            if (sharedKey && shared[sharedKey].shareConfig.eager === true) {
              return 'loadShare-eager';
            }
            // import: false has no local fallback that could create circular imports.
            // Let the bundler group these modules to avoid a request per dependency.
            if (sharedKey && shared[sharedKey].shareConfig.import === false) return null;
            // Keep CommonJS proxies separate so generateBundle can find them by filename.
            // The plugin instance that created a loadShare module decides whether
            // it can share a chunk, even when another instance runs this callback.
            if (
              packageName &&
              !id.includes('commonjs-proxy') &&
              isCoalescableLoadShareWrapper(packageName, options, id)
            ) {
              return getSharedChunkName(id);
            }
            // Use the virtual module path as the chunk name
            const match = id.match(/([^/\\]+__loadShare__[^/\\]+)/);
            return match ? match[1] : 'loadShare';
          }
          return null;
        };
        installedManualChunks.add(getRuntimeChunkName);

        if (bundler === 'rollup') {
          applyRollupPlacement(output, getRuntimeChunkName, hasInstalledManualChunks);
        } else {
          applyRolldownPlacement(output, getRuntimeChunkName, hasInstalledManualChunks);
        }
      };

      // Vite 8 types both fields as Rolldown options. On Vite 5–7,
      // rollupOptions uses Rollup callbacks instead.
      const buildOptions = build as {
        rollupOptions?: ChunkBuildOptions;
        rolldownOptions?: ChunkBuildOptions;
      };
      getOutputConfigs((buildOptions.rollupOptions ||= {})).forEach((output) =>
        configureChunkPlacement(output, 'rollup')
      );
      const outputConfigs = getOutputConfigs((buildOptions.rolldownOptions ||= {}));
      outputConfigs.forEach((output) => configureChunkPlacement(output, 'rolldown'));
      // Vite 8 overwrites output names after config. Capture only those fields;
      // buildApp restores them without overwriting other output settings.
      configuredOutputNames = outputConfigs.map(
        ({ entryFileNames, chunkFileNames, assetFileNames }) => ({
          entryFileNames,
          chunkFileNames,
          assetFileNames,
        })
      );
    },
    async restoreOutputFileNames(builder: BuilderWithOutputOptions) {
      const savedOutputNames = configuredOutputNames;
      if (!savedOutputNames) return;

      const restoreOutputNamesForConfig = (
        output: ChunkOutputOptions | undefined,
        savedNames: OutputFileNames | undefined
      ) => {
        if (!output || !savedNames) return;
        if (savedNames.entryFileNames !== undefined) {
          output.entryFileNames = savedNames.entryFileNames;
        }
        if (savedNames.chunkFileNames !== undefined) {
          output.chunkFileNames = savedNames.chunkFileNames;
        }
        if (savedNames.assetFileNames !== undefined) {
          output.assetFileNames = savedNames.assetFileNames;
        }
      };

      for (const environment of Object.values(builder.environments)) {
        const getRolldownOptions = environment.getRolldownOptions;
        if (typeof getRolldownOptions !== 'function') continue;

        environment.getRolldownOptions = async () => {
          const rolldownOptions = await getRolldownOptions.call(environment);
          getOutputConfigs(rolldownOptions).forEach((output, index) => {
            restoreOutputNamesForConfig(output, savedOutputNames[index]);
          });
          return rolldownOptions;
        };
      }
    },
  };
}
