/**
 * Single Source of Truth (SSOT) for plugin identities, runtime inventories,
 * VSIX / CLI / release allowlists, and open-source export exclusions.
 */

export const PLUGIN_NAME = 'antigravity-pulse';
export const UPDATE_REPO = 'ShZbz/antigravity-dashboard';

export const IDE_PUBLISHER = 'shzbz';
export const IDE_PACKAGE_NAME = 'antigrative-dashboard-ide';
export const IDE_EXTENSION_ID = `${IDE_PUBLISHER}.${IDE_PACKAGE_NAME}`;

export const CLI_INSTALL_NAME = 'antigrative-dashboard-cli';

export const DESKTOP_RUNTIME_ROOTS = ['assets', 'compat', 'sidecars', 'plugin.json'] as const;

export const DESKTOP_RUNTIME_EXCLUDED_DIRS = new Set<string>([
  'tests',
]);

export const DESKTOP_RUNTIME_EXCLUDED_REL_FILES = new Set<string>([
  'sidecars/panel/toolbar-preview.html',
]);

export const DESKTOP_RUNTIME_IGNORED_SUFFIXES = new Set<string>([
  '.pyc',
  '.log',
  '.pdb',
  '.exp',
  '.lib',
  '.exe',
]);

export const DESKTOP_REQUIRED_FILES = [
  'plugin.json',
  'compat/inline-widget.cjs',
  'compat/runtime-ui.mjs',
  'compat/i18n.cjs',
  'compat/theme.cjs',
  'sidecars/panel/main.mjs',
  'sidecars/panel/metrics.mjs',
  'sidecars/panel/history.mjs',
  'assets/logo.svg',
] as const;

export const PRIVATE_RUNTIME_DIRS = [
  'data',
  'history-v1',
  'usage-v1',
  'timeline-v1',
  'sdk',
] as const;

export const PACKAGER_IGNORED_NAMES = new Set<string>([
  '__pycache__',
  '.pytest_cache',
  '.data',
  'node_modules',
  '.git',
  'dist',
  'internal',
  'target',
  'ag-pulse-statusline',
  'ag-pulse-statusline.exe',
  'ag-pulse-statusline.darwin-x64',
  'ag-pulse-statusline.darwin-arm64',
  'ag-pulse-statusline.linux-x64',
  'ag-pulse-statusline.linux-arm64',
  'REFACTORING_ROADMAP.md',
  ...PRIVATE_RUNTIME_DIRS,
]);

export const PACKAGER_IGNORED_SUFFIXES = new Set<string>([
  '.log',
  '.pyc',
  '.node',
  '.dll',
  '.so',
  '.dylib',
  '.pdb',
  '.exp',
  '.exe',
  '.lib',
]);

export const RELEASE_NATIVE_PLATFORMS = [
  'win32-x64',
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
] as const;

export const RELEASE_NATIVE_ADDONS = RELEASE_NATIVE_PLATFORMS.map(
  (tag) => `sidecars/panel/pulse-accel.${tag}.node`,
);

export const RELEASE_NATIVE_CLI_BINS = RELEASE_NATIVE_PLATFORMS.map(
  (tag) => `cli/bin/ag-pulse-statusline.${tag}${tag.startsWith('win32-') ? '.exe' : ''}`,
);

export const RELEASE_NATIVE_ALLOWED_FILES = new Set<string>([
  ...RELEASE_NATIVE_ADDONS,
  ...RELEASE_NATIVE_CLI_BINS,
]);

export const IDE_VSIX_MODULES = [
  'compat/runtime-ui.mjs',
  'compat/platform.mjs',
  'compat/preferences.mjs',
  'compat/sidecar-owner.mjs',
  'compat/i18n.cjs',
  'compat/theme.cjs',
  'compat/inline-widget.cjs',
  'compat/usage-ui.cjs',
  'sidecars/panel/client.mjs',
  'sidecars/panel/trajectory-json.mjs',
  'sidecars/panel/trajectory-reader.mjs',
  'sidecars/panel/discovery.mjs',
  'sidecars/panel/store.mjs',
  'sidecars/panel/history.mjs',
  'sidecars/panel/metrics.mjs',
  'sidecars/panel/rate-quality.mjs',
  'sidecars/panel/context.mjs',
  'sidecars/panel/transcript.mjs',
  'sidecars/panel/usage.mjs',
  'sidecars/panel/local-conversations.mjs',
  'sidecars/panel/delegated-usage.mjs',
  'sidecars/panel/delegation.mjs',
  'sidecars/panel/timeline.mjs',
  'sidecars/panel/timeline-store.mjs',
  'sidecars/panel/task-usage.mjs',
  'ide/extension.cjs',
  'ide/host.cjs',
  'ide/main.mjs',
  'ide/client.mjs',
  'ide/discovery.mjs',
  'ide/runtime.mjs',
  'ide/surface.cjs',
  'ide/launch.mjs',
  'ide/manage.mjs',
  'ide/manage.py',
] as const;

export const IDE_VSIX_STATIC_FILES = ['LICENSE', 'ide/README.md'] as const;

export const CLI_RUNTIME_FILES = [
  'cli/metrics.mjs',
  'cli/render.mjs',
  'cli/statusline.mjs',
  'compat/platform.mjs',
  'compat/preferences.mjs',
] as const;

export const DIST_RELEASE_FILES = [
  'plugin.json',
  'assets',
  'sidecars',
  'compat',
  'cli',
  'ide',
  'manage.mjs',
  'manage.py',
  'install.ps1',
  'uninstall.ps1',
  'install.sh',
  'uninstall.sh',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'COMPATIBILITY.md',
  'docs',
  'package.json',
  '.gitignore',
  '.gitattributes',
  '.github',
  'tests',
  'tools',
  'GITHUB_RELEASE.md',
  'README.zh-CN.md',
] as const;

export const RELEASE_ZIP_REQUIRED_FILES = [
  'ide/package.json',
  'ide/manage.mjs',
  'ide/manage.py',
  'ide/package.mjs',
  'ide/package.py',
  'ide/README.md',
  'compat/usage-ui.cjs',
  'sidecars/panel/rate-quality.mjs',
  'sidecars/panel/usage.mjs',
  'sidecars/panel/panel-source.mjs',
  'sidecars/panel/trajectory-json.mjs',
  'sidecars/panel/trajectory-reader.mjs',
  'sidecars/panel/transcript.mjs',
  'compat/update-ui.cjs',
  'compat/update-worker.py',
  'compat/update-lock.py',
  'sidecars/panel/updater.mjs',
  'sidecars/panel/local-conversations.mjs',
  'docs/UPDATES.md',
  'install.sh',
  'uninstall.sh',
  'install.ps1',
  'uninstall.ps1',
  'manage.mjs',
  'compat/runtime-ui.mjs',
  'compat/theme.cjs',
  'compat/host-theme.mjs',
  'compat/preferences.mjs',
  'compat/sidecar-owner.mjs',
  'sidecars/panel/context.mjs',
  'cli/statusline.mjs',
  'cli/metrics.mjs',
  'cli/render.mjs',
  'cli/lifecycle.py',
  'docs/CLI.md',
  'docs/assets/cli-conversation.png',
  'docs/assets/cli-conversation-zh.png',
] as const;

export const RELEASE_VSIX_REQUIRED_FILES = [
  'extension/ide/extension.cjs',
  'extension/ide/host.cjs',
  'extension/ide/main.mjs',
  'extension/ide/surface.cjs',
  'extension/ide/manage.mjs',
  'extension/ide/manage.py',
  'extension/compat/inline-widget.cjs',
  'extension/README.md',
  'extension/LICENSE',
  'extension/compat/usage-ui.cjs',
  'extension/sidecars/panel/rate-quality.mjs',
  'extension/sidecars/panel/usage.mjs',
  'extension/sidecars/panel/trajectory-json.mjs',
  'extension/sidecars/panel/trajectory-reader.mjs',
  'extension/sidecars/panel/transcript.mjs',
  'extension/sidecars/panel/local-conversations.mjs',
] as const;

export const OPENSOURCE_EXCLUDED_DIRS = new Set<string>([
  '.git',
  '.data',
  'dist',
  'scratch',
  'internal',
  'target',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  ...PRIVATE_RUNTIME_DIRS,
  '.gemini',
]);

export const OPENSOURCE_EXCLUDED_REL_FILES = new Set<string>([
  'RULE.md',
  'docs/REFACTORING_ROADMAP.md',
  '.antigravity-pulse-update.lock',
  'settings.json',
  'patch.json',
  'tools/export-opensource.py',
  'tools/export-opensource.mjs',
  'cli/bin/ag-pulse-statusline',
  'cli/bin/ag-pulse-statusline.exe',
  'cli/bin/ag-pulse-statusline.darwin-x64',
  'cli/bin/ag-pulse-statusline.darwin-arm64',
  'cli/bin/ag-pulse-statusline.linux-x64',
  'cli/bin/ag-pulse-statusline.linux-arm64',
  'ag-pulse-statusline',
]);

export const OPENSOURCE_EXCLUDED_SUFFIXES = new Set<string>([
  '.pyc',
  '.pyo',
  '.pyd',
  '.node',
  '.dll',
  '.so',
  '.dylib',
  '.lib',
  '.exp',
  '.pdb',
  '.exe',
  '.log',
  '.asar',
  '.original',
]);

export const OPENSOURCE_TEXT_EXTENSIONS = new Set<string>([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rs',
  '.toml',
  '.py',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.svg',
  '.ps1',
  '.sh',
  '.yml',
  '.yaml',
  '.gitattributes',
  '.gitignore',
]);
