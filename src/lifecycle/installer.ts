import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DESKTOP_RUNTIME_EXCLUDED_DIRS,
  DESKTOP_RUNTIME_EXCLUDED_REL_FILES,
  DESKTOP_RUNTIME_IGNORED_SUFFIXES,
  DESKTOP_RUNTIME_ROOTS,
  IDE_EXTENSION_ID,
  PACKAGER_IGNORED_NAMES,
  PLUGIN_NAME,
  PRIVATE_RUNTIME_DIRS,
} from '../platform/manifest.ts';
import { instancePaths, type InstancePaths } from '../platform/paths.ts';
import { withFileLockSync } from '../shared/file-lock.ts';
import { restoreVerifiedLegacyAdapter } from './asar-recovery.ts';
import {
  applyDebugLaunch,
  getDebugLaunchStatus,
} from './debug-launch.ts';
import {
  copyTreeFilteredSync,
  isReparseOrSymlink,
  readJsonObjectSync,
  writeJsonObjectSync,
} from './fs-helpers.ts';

export type LifecycleInstanceTarget = 'all' | 'pro' | 'vertex';

export interface LifecycleEnvOptions {
  sourceRoot: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  appPath?: string;
}

export interface InstallDesktopOptions extends LifecycleEnvOptions {
  panelOnly?: boolean;
  instance?: LifecycleInstanceTarget;
  enableDebugLaunch?: boolean;
}

export interface IdeManageOptions {
  action: 'install' | 'launch' | 'uninstall';
  executable: string;
  sourceRoot: string;
  vsix?: string;
  workspace?: string;
  platform?: string;
}

interface PluginConfigFile {
  plugins?: Record<string, { enabled?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface DesktopSettingsFile {
  enabled?: boolean;
  inline?: boolean;
  mode?: string;
  appResources?: string;
  profile?: string;
  [key: string]: unknown;
}

export const IDE_DEBUG_ARGS = [
  '--remote-debugging-port=0',
  '--remote-debugging-address=127.0.0.1',
] as const;

const PRIVATE_RUNTIME_DIR_SET = new Set<string>(PRIVATE_RUNTIME_DIRS);

function shouldSkipDesktopRuntimeEntry(relPath: string, entryName: string, isDir: boolean): boolean {
  if (isDir && DESKTOP_RUNTIME_EXCLUDED_DIRS.has(entryName)) return true;
  if (!isDir && DESKTOP_RUNTIME_EXCLUDED_REL_FILES.has(relPath)) return true;
  if (PACKAGER_IGNORED_NAMES.has(entryName)) return true;
  const lower = entryName.toLowerCase();
  for (const suffix of DESKTOP_RUNTIME_IGNORED_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}

function shouldPreserveDesktopRuntimeEntry(_relPath: string, entryName: string, isDir: boolean): boolean {
  return entryName === '.data' || (isDir && PRIVATE_RUNTIME_DIR_SET.has(entryName));
}

function validateInstance(instance: string): asserts instance is LifecycleInstanceTarget {
  if (instance !== 'all' && instance !== 'pro' && instance !== 'vertex') {
    throw new Error(`Invalid instance: ${instance}`);
  }
}

function resolveTargets(options: LifecycleEnvOptions): { pro: InstancePaths; vertex: InstancePaths } {
  const pathOpts = {
    home: options.home,
    env: options.env,
    platform: options.platform,
  };
  const pro = instancePaths('pro', pathOpts);
  if (options.appPath) {
    pro.appAsar = resolve(options.appPath);
  }
  const vertex = instancePaths('vertex', pathOpts);
  return { pro, vertex };
}

function ownPlugin(pluginDir: string, homeDir: string): void {
  const geminiRoot = resolve(join(homeDir, '.gemini'));
  const configRoot = resolve(join(geminiRoot, 'config'));
  const pluginsRoot = resolve(join(configRoot, 'plugins'));
  if (
    isReparseOrSymlink(geminiRoot) ||
    isReparseOrSymlink(configRoot) ||
    isReparseOrSymlink(pluginsRoot) ||
    isReparseOrSymlink(pluginDir) ||
    (existsSync(pluginDir) && realpathSync(dirname(resolve(pluginDir))) !== realpathSync(pluginsRoot))
  ) {
    throw new Error('Plugin destination must be a regular directory inside the customization root.');
  }
  if (existsSync(pluginDir)) {
    const manifest = readJsonObjectSync<{ name?: string }>(join(pluginDir, 'plugin.json'));
    if (manifest.name !== PLUGIN_NAME) {
      throw new Error('Destination is not an Antigrative Dashboard installation; refusing to overwrite it.');
    }
  }
}

function guardDuplicatePlugins(pluginDir: string, configFile: string): void {
  const parent = dirname(pluginDir);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) return;
  const targetName = pluginDir.split(/[\\/]/).pop();
  const duplicates: string[] = [];

  for (const entry of readdirSync(parent, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() || entry.name === targetName || entry.name.startsWith('.')) continue;
    const child = join(parent, entry.name);
    try {
      const meta = readJsonObjectSync<{ name?: string }>(join(child, 'plugin.json'));
      if (meta.name === PLUGIN_NAME) duplicates.push(child);
    } catch {
      // Ignore unreadable directories.
    }
  }
  if (duplicates.length === 0) return;

  if (existsSync(configFile)) {
    const conf = readJsonObjectSync<PluginConfigFile>(configFile);
    if (conf.plugins && typeof conf.plugins === 'object' && !Array.isArray(conf.plugins)) {
      let changed = false;
      for (const dup of duplicates) {
        const dupName = dup.split(/[\\/]/).pop() || '';
        const item = conf.plugins[dupName];
        if (item && item.enabled !== false) {
          item.enabled = false;
          changed = true;
        }
      }
      if (changed) writeJsonObjectSync(configFile, conf);
    }
  }
  for (const dup of duplicates) {
    console.error(
      `WARNING: Duplicate antigravity-pulse folder found in plugins directory (move backups out of ${parent} to avoid sidecar hijacking): ${dup}`,
    );
  }
}

function withLifecycleLock<T>(pluginDir: string, fn: () => T): T {
  const pluginsParent = dirname(pluginDir);
  const lockPath = join(pluginsParent, '.antigravity-pulse-update.lock');
  if (isReparseOrSymlink(lockPath)) {
    throw new Error('Linked lifecycle lock is unsupported');
  }
  const transactionJournal = join(pluginsParent, '.antigravity-pulse-update-transaction', 'journal.json');
  const assertNoInterruptedTx = () => {
    if (existsSync(transactionJournal)) {
      throw new Error(
        'An interrupted update requires recovery. Run the saved recover.py helper before installing or uninstalling.',
      );
    }
  };

  // If Python's update-lock.py holds an OS flock/msvcrt lock on '.antigravity-pulse-update.lock',
  // file exists with non-JSON content '0' or raises read lock error.
  if (existsSync(lockPath)) {
    let content = '';
    try {
      content = readFileSync(lockPath, 'utf8');
    } catch {
      throw new Error('Another lifecycle operation is running');
    }
    if (content === '0') {
      try {
        rmSync(lockPath);
      } catch {
        throw new Error('Another lifecycle operation is running');
      }
    }
  }

  return withFileLockSync(
    lockPath,
    () => {
      assertNoInterruptedTx();
      return fn();
    },
    { timeoutMs: 25, timeoutMessage: 'Another lifecycle operation is running' },
  );
}

function updateInstanceEnabled(
  enabled: boolean,
  inst: InstancePaths,
  checkSettingsDir = false,
): void {
  ownPlugin(inst.pluginDir, inst.home);
  if (!existsSync(join(inst.pluginDir, 'plugin.json'))) {
    throw new Error('Install Antigrative Dashboard before changing its state.');
  }
  const config = readJsonObjectSync<PluginConfigFile>(inst.pluginConfig);
  if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
    config.plugins = {};
  }
  if (!config.plugins[PLUGIN_NAME] || typeof config.plugins[PLUGIN_NAME] !== 'object') {
    config.plugins[PLUGIN_NAME] = {};
  }
  config.plugins[PLUGIN_NAME].enabled = enabled;
  writeJsonObjectSync(inst.pluginConfig, config);

  if (!checkSettingsDir || existsSync(inst.data) || existsSync(inst.instanceSettings)) {
    const settings = readJsonObjectSync<DesktopSettingsFile>(inst.instanceSettings);
    settings.enabled = enabled;
    writeJsonObjectSync(inst.instanceSettings, settings);
  }
}

function removePluginDir(pluginDir: string, homeDir: string): void {
  const resolved = resolve(pluginDir);
  const geminiRoot = resolve(join(homeDir, '.gemini'));
  const configRoot = resolve(join(geminiRoot, 'config'));
  const expectedParent = resolve(join(configRoot, 'plugins'));
  if (
    isReparseOrSymlink(geminiRoot) ||
    isReparseOrSymlink(configRoot) ||
    isReparseOrSymlink(expectedParent) ||
    isReparseOrSymlink(pluginDir) ||
    dirname(resolved) !== expectedParent ||
    resolved !== resolve(join(expectedParent, PLUGIN_NAME))
  ) {
    throw new Error('Plugin target is outside the expected directory; refusing to delete it.');
  }
  rmSync(resolved, { recursive: true, force: true });
}

/**
 * Installs or updates desktop runtime files for Pro and/or `.antigravity-vertex`.
 */
export function installDesktop(options: InstallDesktopOptions): void {
  const instance = options.instance ?? 'all';
  const panelOnly = Boolean(options.panelOnly);
  validateInstance(instance);
  const { pro, vertex } = resolveTargets(options);

  withLifecycleLock(pro.pluginDir, () => {
    if (instance === 'all' || instance === 'pro') {
      ownPlugin(pro.pluginDir, pro.home);
      const config = readJsonObjectSync<PluginConfigFile>(pro.pluginConfig);
      if (config.plugins !== undefined && (typeof config.plugins !== 'object' || Array.isArray(config.plugins))) {
        throw new Error('Existing customization configuration has an incompatible shape.');
      }
      if (!panelOnly) {
        if (!existsSync(pro.appAsar) || !statSync(pro.appAsar).isFile()) {
          throw new Error(
            'Antigravity desktop app not found. Use --app-path /path/to/resources/app.asar for a custom installation. See COMPATIBILITY.md.',
          );
        }
        if (restoreVerifiedLegacyAdapter(pro.appAsar, pro.backups)) {
          console.log('Restored the exact verified legacy archive; future updates need no archive patches.');
        }
      }
    }

    const installVertex =
      (instance === 'all' || instance === 'vertex') &&
      (vertex.exists || existsSync(dirname(vertex.pluginDir)) || instance === 'vertex');
    if (installVertex) {
      ownPlugin(vertex.pluginDir, vertex.home);
    }

    const destinations: string[] = [];
    if (instance === 'all' || instance === 'pro') destinations.push(pro.pluginDir);
    if (installVertex) destinations.push(vertex.pluginDir);

    const localAccounts = join(options.sourceRoot, '.data', 'usage-accounts.local.json');
    for (const dest of destinations) {
      mkdirSync(dest, { recursive: true });
      for (const name of DESKTOP_RUNTIME_ROOTS) {
        const src = join(options.sourceRoot, name);
        const dst = join(dest, name);
        if (resolve(src) === resolve(dst)) continue;
        if (!existsSync(src) && (name === 'mcp' || name === 'mcp_config.json')) continue;
        copyTreeFilteredSync(src, dst, shouldSkipDesktopRuntimeEntry, name, {
          prune: true,
          shouldPreserve: shouldPreserveDesktopRuntimeEntry,
        });
      }
      if (resolve(options.sourceRoot) !== resolve(dest)) {
        const strayLock = join(dest, '.antigravity-pulse-update.lock');
        if (existsSync(strayLock) && !isReparseOrSymlink(strayLock) && lstatSync(strayLock).isFile()) {
          try {
            rmSync(strayLock, { force: true });
          } catch {
            // Best-effort cleanup of stray lock inside plugin root (real lock lives in parent dir).
          }
        }
      }
      if (existsSync(localAccounts) && statSync(localAccounts).isFile()) {
        const targetAccounts = join(dest, '.data', 'usage-accounts.local.json');
        if (resolve(localAccounts) !== resolve(targetAccounts)) {
          mkdirSync(dirname(targetAccounts), { recursive: true });
          copyFileSync(localAccounts, targetAccounts);
        }
      }
      console.log(`Installed runtime files to: ${dest}`);
    }

    if (instance === 'all' || instance === 'pro') {
      const settings = readJsonObjectSync<DesktopSettingsFile>(pro.instanceSettings);
      settings.inline = !panelOnly;
      settings.mode = 'runtime';
      if (existsSync(pro.appAsar) && statSync(pro.appAsar).isFile()) {
        settings.appResources = dirname(pro.appAsar);
      }
      if (options.env?.AG_PULSE_PROFILE ?? process.env.AG_PULSE_PROFILE) {
        settings.profile = pro.profile;
      }
      writeJsonObjectSync(pro.instanceSettings, settings);
      updateInstanceEnabled(true, pro);
      guardDuplicatePlugins(pro.pluginDir, pro.pluginConfig);
      console.log(`Installed to Pro instance: ${pro.pluginDir}`);
    }

    if (installVertex) {
      if (existsSync(dirname(vertex.pluginConfig))) {
        const vConf = readJsonObjectSync<PluginConfigFile>(vertex.pluginConfig);
        if (!vConf.plugins || typeof vConf.plugins !== 'object' || Array.isArray(vConf.plugins)) {
          vConf.plugins = {};
        }
        vConf.plugins[PLUGIN_NAME] = { ...(vConf.plugins[PLUGIN_NAME] || {}), enabled: true };
        writeJsonObjectSync(vertex.pluginConfig, vConf);
        guardDuplicatePlugins(vertex.pluginDir, vertex.pluginConfig);
      }
      if (existsSync(vertex.data) || existsSync(vertex.instanceSettings)) {
        const vSettings = readJsonObjectSync<DesktopSettingsFile>(vertex.instanceSettings);
        vSettings.inline = !panelOnly;
        vSettings.mode = 'runtime';
        vSettings.enabled = true;
        writeJsonObjectSync(vertex.instanceSettings, vSettings);
      }
      console.log(`Installed to Vertex instance: ${vertex.pluginDir}`);
    }

    const prefsFile = join(dirname(pro.settings), 'preferences.json');
    const savedPrefs = existsSync(prefsFile)
      ? readJsonObjectSync<{ debugLaunchEnabled?: unknown }>(prefsFile)
      : {};
    const shouldConfigureDebugLaunch =
      options.enableDebugLaunch === true || savedPrefs.debugLaunchEnabled === true;
    if (shouldConfigureDebugLaunch && !panelOnly) {
      const outcome = applyDebugLaunch(true, {
        home: options.home,
        env: options.env,
        platform: options.platform,
        appPath: options.appPath,
      });
      console.log(outcome.message);
    }
  });

  console.log('Fully quit and reopen Antigravity to start the plugin runtime. App updates no longer overwrite the inline adapter.');
}

/**
 * Enables or disables the desktop plugin for Pro, Vertex, or both instances.
 */
export function setDesktopEnabled(
  enabled: boolean,
  options: LifecycleEnvOptions & { instance?: LifecycleInstanceTarget },
): void {
  const instance = options.instance ?? 'all';
  validateInstance(instance);
  const { pro, vertex } = resolveTargets(options);

  if (instance === 'all' || instance === 'pro') {
    updateInstanceEnabled(enabled, pro);
  }
  if (instance === 'all' || instance === 'vertex') {
    if (existsSync(join(vertex.pluginDir, 'plugin.json')) || instance === 'vertex') {
      updateInstanceEnabled(enabled, vertex, true);
    }
  }
  console.log(
    enabled
      ? 'Antigrative Dashboard enabled.'
      : 'Antigrative Dashboard disabled; the toolbar hides on its next poll.',
  );
}

/**
 * Uninstalls the desktop plugin and safely restores any verified legacy ASAR backup.
 */
export function uninstallDesktop(
  options: LifecycleEnvOptions & { instance?: LifecycleInstanceTarget },
): void {
  const instance = options.instance ?? 'all';
  validateInstance(instance);
  const { pro, vertex } = resolveTargets(options);

  withLifecycleLock(pro.pluginDir, () => {
    if (instance === 'all' || instance === 'pro') {
      ownPlugin(pro.pluginDir, pro.home);
      if (
        restoreVerifiedLegacyAdapter(pro.appAsar, pro.backups, {
          onRestoreErrorMessage: 'Restored application verification failed.',
          onUnknownChangeMessage: 'Application changed since patching. Inspect the backup before uninstalling.',
        })
      ) {
        console.log('Original Antigravity archive restored.');
      }
      if (existsSync(pro.pluginDir)) {
        updateInstanceEnabled(false, pro);
        removePluginDir(pro.pluginDir, pro.home);
      } else {
        writeJsonObjectSync(pro.instanceSettings, { enabled: false });
      }
    }

    if (instance === 'all' || instance === 'vertex') {
      ownPlugin(vertex.pluginDir, vertex.home);
      if (existsSync(vertex.pluginDir)) {
        updateInstanceEnabled(false, vertex, true);
        removePluginDir(vertex.pluginDir, vertex.home);
      } else if (existsSync(vertex.instanceSettings)) {
        writeJsonObjectSync(vertex.instanceSettings, { enabled: false });
      }
    }

    if (instance === 'all' || instance === 'pro') {
      try {
        applyDebugLaunch(false, {
          home: options.home,
          env: options.env,
          platform: options.platform,
          appPath: options.appPath,
        });
      } catch {
        // Best-effort cleanup of debug launch shortcuts on uninstall.
      }
    }
  });

  console.log('Antigrative Dashboard removed. Backups and diagnostic logs are retained for recovery.');
  console.log('Fully quit and reopen Antigravity to unload the UI adapter.');
}

/**
 * Prints and returns dual-instance installation and integration health status.
 */
export function statusDesktop(
  options: LifecycleEnvOptions & { instance?: LifecycleInstanceTarget },
): Record<string, unknown> {
  const instance = options.instance ?? 'all';
  validateInstance(instance);
  const { pro, vertex } = resolveTargets(options);

  const proInstalled = existsSync(join(pro.pluginDir, 'plugin.json'));
  const proConf = readJsonObjectSync<PluginConfigFile>(pro.pluginConfig);
  const proEnabled = proInstalled && (proConf.plugins?.[PLUGIN_NAME]?.enabled ?? true);
  const proHealth = existsSync(pro.health) ? readJsonObjectSync(pro.health) : null;
  const recoverable =
    existsSync(pro.appAsar) &&
    (() => {
      try {
        const buf = readFileSync(pro.appAsar);
        return existsSync(pro.backups) && buf.length > 0 && restorePreviewRecoverable(buf, pro.backups);
      } catch {
        return false;
      }
    })();

  const proPayload = {
    installed: proInstalled,
    enabled: Boolean(proEnabled),
    pluginDirectory: pro.pluginDir,
    integrationMode: readJsonObjectSync<DesktopSettingsFile>(pro.instanceSettings).mode ?? 'legacy',
    inlineIntegration: proHealth,
    debugLaunch: getDebugLaunchStatus({
      home: options.home,
      env: options.env,
      platform: options.platform,
      appPath: options.appPath,
    }),
    toolbarAdapterRecoverable: recoverable,
  };

  const vInstalled = existsSync(join(vertex.pluginDir, 'plugin.json'));
  const vConf = readJsonObjectSync<PluginConfigFile>(vertex.pluginConfig);
  const vEnabled = vInstalled && (vConf.plugins?.[PLUGIN_NAME]?.enabled ?? true);
  const vHealth = existsSync(vertex.health) ? readJsonObjectSync(vertex.health) : null;
  const vPayload = {
    installed: vInstalled,
    enabled: Boolean(vEnabled),
    pluginDirectory: vertex.pluginDir,
    integrationMode:
      readJsonObjectSync<DesktopSettingsFile>(vertex.instanceSettings).mode ??
      (vInstalled ? 'runtime' : 'legacy'),
    inlineIntegration: vHealth,
  };

  const payload = { ...(instance === 'vertex' ? vPayload : proPayload), vertex: vPayload };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function restorePreviewRecoverable(current: Buffer, backupsDir: string): boolean {
  try {
    return current.includes('// AG_PULSE_INLINE_V1') && existsSync(backupsDir);
  } catch {
    return false;
  }
}

/**
 * Resolves the standalone Antigravity IDE executable and bundled `resources/app` directory.
 */
export function resolveIdeApplication(executable: string): { executable: string; appDir: string } {
  const resolved = resolve(executable);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('--exe must name the IDE executable, not its directory or .app bundle');
  }
  const candidates = [
    join(dirname(resolved), 'resources', 'app'),
    join(dirname(dirname(resolved)), 'Resources', 'app'),
  ];
  for (const appDir of candidates) {
    try {
      const product = readJsonObjectSync<{ applicationName?: string }>(join(appDir, 'product.json'));
      if (product.applicationName === 'antigravity-ide' && existsSync(join(appDir, 'out', 'cli.js'))) {
        return { executable: resolved, appDir };
      }
    } catch {
      // Try next candidate.
    }
  }
  throw new Error('This installer supports the standalone Antigravity IDE only');
}

/**
 * Installs, launches with loopback debugging, or uninstalls the standalone Antigravity IDE extension.
 */
export function manageIde(options: IdeManageOptions): ChildProcess | void {
  const { executable, appDir } = resolveIdeApplication(options.executable);
  const platform = options.platform ?? process.platform;
  if (options.action === 'launch') {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args: string[] = [...IDE_DEBUG_ARGS];
    if (options.workspace) args.push(resolve(options.workspace));
    const child = spawn(executable, args, {
      env,
      stdio: 'ignore',
      detached: platform !== 'win32',
      windowsHide: platform === 'win32',
    });
    child.unref();
    return child;
  }

  let cliArgs: string[];
  if (options.action === 'install') {
    let vsixPath = options.vsix;
    if (!vsixPath) {
      const pkg = readJsonObjectSync<{ version: string }>(join(options.sourceRoot, 'ide', 'package.json'));
      vsixPath = join(options.sourceRoot, 'dist', `antigrative-dashboard-ide-${pkg.version}.vsix`);
    }
    const resolvedVsix = resolve(vsixPath);
    if (!existsSync(resolvedVsix)) {
      throw new Error(`VSIX package not found: ${resolvedVsix}`);
    }
    cliArgs = ['--install-extension', resolvedVsix, '--force'];
  } else if (options.action === 'uninstall') {
    cliArgs = ['--uninstall-extension', IDE_EXTENSION_ID];
  } else {
    throw new Error('Unknown IDE action');
  }

  execFileSync(executable, [join(appDir, 'out', 'cli.js'), ...cliArgs], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: platform === 'win32',
  });
}
