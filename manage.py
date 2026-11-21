"""Dependency-free Antigrative Dashboard installer, switch, uninstaller and packager."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import zipfile
from functools import wraps

SOURCE = Path(__file__).resolve().parent
_path_spec = importlib.util.spec_from_file_location('pulse_paths', SOURCE / 'compat' / 'platform_paths.py')
_paths_module = importlib.util.module_from_spec(_path_spec)
_path_spec.loader.exec_module(_paths_module)
_paths = _paths_module.platform_paths()
HOME = _paths['home']
LOCAL = _paths['local']
PLUGIN = HOME / '.gemini' / 'config' / 'plugins' / 'antigravity-pulse'
CONFIG = HOME / '.gemini' / 'config' / 'config.json'
SETTINGS = _paths['settings']
APP = _paths['app']
BACKUPS = _paths['backups']
RUNTIME_FILES = ('assets', 'compat', 'sidecars', 'plugin.json')
DIST_FILES = ('plugin.json', 'assets', 'sidecars', 'compat', 'cli', 'ide', 'manage.mjs', 'manage.py', 'install.ps1',
              'uninstall.ps1', 'install.sh', 'uninstall.sh', 'README.md', 'LICENSE', 'CHANGELOG.md', 'COMPATIBILITY.md', 'docs', 'package.json',
              '.gitignore', '.gitattributes', '.github', 'tests', 'tools', 'GITHUB_RELEASE.md', 'README.zh-CN.md')
PRIVATE_RUNTIME_DIRS = frozenset({'data', 'history-v1', 'usage-v1', 'timeline-v1', 'sdk'})
DESKTOP_RUNTIME_EXCLUDED_DIRS = frozenset({'tests'})
DESKTOP_RUNTIME_EXCLUDED_REL_FILES = frozenset({'sidecars/panel/toolbar-preview.html'})
DESKTOP_RUNTIME_IGNORED_SUFFIXES = frozenset({'.pyc', '.log', '.pdb', '.exp', '.lib', '.exe'})
IGNORED = {
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
    *PRIVATE_RUNTIME_DIRS,
}
RELEASE_NATIVE_PLATFORMS = ('win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64')
RELEASE_NATIVE_ADDONS = tuple(f'sidecars/panel/pulse-accel.{tag}.node' for tag in RELEASE_NATIVE_PLATFORMS)
RELEASE_NATIVE_CLI_BINS = tuple(
    f"cli/bin/ag-pulse-statusline.{tag}{'.exe' if tag.startswith('win32-') else ''}"
    for tag in RELEASE_NATIVE_PLATFORMS
)
RELEASE_NATIVE_ALLOWED = frozenset(RELEASE_NATIVE_ADDONS + RELEASE_NATIVE_CLI_BINS)

def lifecycle_operation(function):
    @wraps(function)
    def locked(*args, **kwargs):
        spec = importlib.util.spec_from_file_location('pulse_update_lock', SOURCE / 'compat/update-lock.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with module.lifecycle_lock(PLUGIN):
            transaction = PLUGIN.parent / '.antigravity-pulse-update-transaction'
            if (transaction / 'journal.json').exists():
                raise RuntimeError('An interrupted update requires recovery. Run the saved recover.py helper before installing or uninstalling.')
            return function(*args, **kwargs)
    return locked

def json_read(file, default=None):
    if not file.exists():
        return {} if default is None else default
    return json.loads(file.read_text(encoding='utf-8-sig'))

def atomic_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    temporary = file.with_name(file.name + '.tmp')
    temporary.write_text(text, encoding='utf-8')
    try:
        os.replace(temporary, file)
    except PermissionError:
        file.write_text(text, encoding='utf-8')
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass

def vertex_paths():
    v_home = HOME / '.antigravity-vertex' / 'home'
    v_plugin = v_home / '.gemini' / 'config' / 'plugins' / 'antigravity-pulse'
    v_config = v_home / '.gemini' / 'config' / 'config.json'
    v_data = v_home / '.gemini' / 'antigravity' / 'sidecar_data' / 'antigravity-pulse' / 'panel' / 'data'
    return {
        'home': v_home,
        'plugin': v_plugin,
        'config': v_config,
        'data': v_data,
        'settings': v_data / 'settings.json',
        'health': v_data / 'integration-state.json',
    }

def _is_reparse_or_symlink(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400):
        return True
    if not path.exists():
        return True
    return path.resolve() != (path.parent.resolve() / path.name)

def own_plugin(plugin_dir=None, home_dir=None):
    plugin = PLUGIN if plugin_dir is None else plugin_dir
    home = HOME if home_dir is None else home_dir
    gemini_root = home / '.gemini'
    config_root = gemini_root / 'config'
    plugins_root = config_root / 'plugins'
    if (
        _is_reparse_or_symlink(gemini_root)
        or _is_reparse_or_symlink(config_root)
        or _is_reparse_or_symlink(plugins_root)
        or _is_reparse_or_symlink(plugin)
        or (plugin.exists() and plugin.resolve().parent != plugins_root.resolve())
    ):
        raise RuntimeError('Plugin destination must be a regular directory inside the customization root.')
    if plugin.exists() and json_read(plugin / 'plugin.json').get('name') != 'antigravity-pulse':
        raise RuntimeError('Destination is not an Antigrative Dashboard installation; refusing to overwrite it.')

def guard_duplicate_plugins(plugin_dir, config_file):
    parent = plugin_dir.parent
    if not parent.is_dir():
        return
    duplicates = []
    for child in sorted(parent.iterdir()):
        if child.name == plugin_dir.name or child.name.startswith('.') or not child.is_dir():
            continue
        try:
            meta = json_read(child / 'plugin.json', {})
        except Exception:
            continue
        if isinstance(meta, dict) and meta.get('name') == 'antigravity-pulse':
            duplicates.append(child)
    if not duplicates:
        return
    if config_file.exists():
        conf = json_read(config_file)
        if isinstance(conf, dict) and isinstance(conf.get('plugins'), dict):
            changed = False
            for dup in duplicates:
                if dup.name in conf['plugins'] and conf['plugins'][dup.name].get('enabled') is not False:
                    conf['plugins'][dup.name]['enabled'] = False
                    changed = True
            if changed:
                atomic_json(config_file, conf)
    for dup in duplicates:
        print(f'WARNING: Duplicate antigravity-pulse folder found in plugins directory (move backups out of {parent} to avoid sidecar hijacking): {dup}', file=sys.stderr)

def adapter():
    spec = importlib.util.spec_from_file_location('pulse_adapter', SOURCE / 'compat' / 'patch-loader.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.APP = APP
    module.BACKUPS = BACKUPS
    return module

def original_for_current(current):
    digest = hashlib.sha256(current).hexdigest()
    if not BACKUPS.exists():
        return None
    for directory in sorted(BACKUPS.iterdir(), reverse=True):
        note = json_read(directory / 'patch.json')
        if note.get('patchedSha256') == digest:
            original = (directory / 'app.asar').read_bytes()
            if hashlib.sha256(original).hexdigest() != note.get('originalSha256'):
                raise RuntimeError('Original application backup failed its integrity check.')
            return original
    return None

def _validate_instance(instance):
    if instance not in ('all', 'pro', 'vertex'):
        raise ValueError(f'Invalid instance: {instance}')

def _update_instance_enabled(enabled, plugin_dir, home_dir, config_file, settings_file, settings_dir=None):
    own_plugin(plugin_dir, home_dir)
    if not (plugin_dir / 'plugin.json').exists():
        raise RuntimeError('Install Antigrative Dashboard before changing its state.')
    config = json_read(config_file)
    entry = config.setdefault('plugins', {}).setdefault('antigravity-pulse', {})
    entry['enabled'] = bool(enabled)
    atomic_json(config_file, config)
    if settings_dir is None or settings_dir.exists() or settings_file.exists():
        settings = json_read(settings_file)
        settings['enabled'] = bool(enabled)
        atomic_json(settings_file, settings)

def _remove_plugin_dir(plugin_dir, home_dir):
    resolved = plugin_dir.resolve()
    gemini_root = home_dir / '.gemini'
    config_root = gemini_root / 'config'
    expected_parent = config_root / 'plugins'
    if (
        _is_reparse_or_symlink(gemini_root)
        or _is_reparse_or_symlink(config_root)
        or _is_reparse_or_symlink(expected_parent)
        or _is_reparse_or_symlink(plugin_dir)
        or resolved.parent != expected_parent.resolve()
        or resolved.name != 'antigravity-pulse'
    ):
        raise RuntimeError('Plugin target is outside the expected directory; refusing to delete it.')
    shutil.rmtree(resolved)

def set_enabled(enabled, instance='all'):
    _validate_instance(instance)
    if instance in ('all', 'pro'):
        _update_instance_enabled(enabled, PLUGIN, HOME, CONFIG, SETTINGS)
    if instance in ('all', 'vertex'):
        vp = vertex_paths()
        if (vp['plugin'] / 'plugin.json').exists() or instance == 'vertex':
            _update_instance_enabled(enabled, vp['plugin'], vp['home'], vp['config'], vp['settings'], vp['data'])
    print('Antigrative Dashboard enabled.' if enabled else 'Antigrative Dashboard disabled; the toolbar hides on its next poll.')

def remove_verified_legacy_adapter():
    if not APP.is_file():
        return
    current = APP.read_bytes()
    original = original_for_current(current)
    if original is not None:
        APP.write_bytes(original)
        if APP.read_bytes() != original:
            raise RuntimeError('Legacy adapter restoration verification failed.')
        print('Restored the exact verified legacy archive; future updates need no archive patches.')
    elif b'// AG_PULSE_INLINE_V1' in current:
        raise RuntimeError('The legacy adapter has unknown app changes; refusing to overwrite them. Inspect its backup first.')


def _should_skip_desktop_runtime(rel_posix, name, is_dir):
    if is_dir and name in DESKTOP_RUNTIME_EXCLUDED_DIRS:
        return True
    if not is_dir and rel_posix in DESKTOP_RUNTIME_EXCLUDED_REL_FILES:
        return True
    if name in IGNORED:
        return True
    return Path(name).suffix.lower() in DESKTOP_RUNTIME_IGNORED_SUFFIXES

def _should_preserve_desktop_runtime(name, is_dir):
    return name == '.data' or (is_dir and name in PRIVATE_RUNTIME_DIRS)

def _entry_compare_key(name):
    return name.lower() if (os.name == 'nt' or sys.platform == 'darwin') else name

def _path_lstat(path: Path):
    try:
        return path.lstat()
    except FileNotFoundError:
        return None

def _remove_path(path: Path) -> None:
    info = _path_lstat(path)
    if info is None:
        return
    is_reparse = bool(getattr(info, 'st_file_attributes', 0) & 0x400)
    is_link = stat.S_ISLNK(info.st_mode) or is_reparse or _is_reparse_or_symlink(path)
    if is_link:
        if os.name == 'nt' and (bool(getattr(info, 'st_file_attributes', 0) & 0x10) or stat.S_ISDIR(info.st_mode)):
            path.rmdir()
        else:
            path.unlink(missing_ok=True)
    elif stat.S_ISDIR(info.st_mode):
        for child in list(path.iterdir()):
            _remove_path(child)
        path.rmdir()
    else:
        path.unlink(missing_ok=True)

def _sync_runtime_tree(source, target, rel_prefix=''):
    if not source.is_dir():
        target_info = _path_lstat(target)
        if target_info is not None and (
            stat.S_ISDIR(target_info.st_mode)
            or stat.S_ISLNK(target_info.st_mode)
            or _is_reparse_or_symlink(target)
        ):
            _remove_path(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return
    target_info = _path_lstat(target)
    if target_info is not None and (
        not stat.S_ISDIR(target_info.st_mode)
        or stat.S_ISLNK(target_info.st_mode)
        or _is_reparse_or_symlink(target)
    ):
        _remove_path(target)
    target.mkdir(parents=True, exist_ok=True)
    expected = {}
    for entry in source.iterdir():
        rel_posix = f'{rel_prefix}/{entry.name}' if rel_prefix else entry.name
        is_dir = entry.is_dir() and not entry.is_symlink() and not _is_reparse_or_symlink(entry)
        if _should_skip_desktop_runtime(rel_posix, entry.name, is_dir):
            continue
        dst_child = target / entry.name
        dst_info = _path_lstat(dst_child)
        if is_dir:
            expected[_entry_compare_key(entry.name)] = 'dir'
            if dst_info is not None and (
                not stat.S_ISDIR(dst_info.st_mode)
                or stat.S_ISLNK(dst_info.st_mode)
                or _is_reparse_or_symlink(dst_child)
            ):
                _remove_path(dst_child)
            _sync_runtime_tree(entry, dst_child, rel_posix)
        elif entry.is_file() and not entry.is_symlink():
            expected[_entry_compare_key(entry.name)] = 'file'
            if dst_info is not None and (
                stat.S_ISDIR(dst_info.st_mode)
                or stat.S_ISLNK(dst_info.st_mode)
                or _is_reparse_or_symlink(dst_child)
            ):
                _remove_path(dst_child)
            shutil.copy2(entry, dst_child)
    for entry in list(target.iterdir()):
        entry_info = _path_lstat(entry)
        if entry_info is None:
            continue
        is_link = stat.S_ISLNK(entry_info.st_mode) or _is_reparse_or_symlink(entry)
        is_dir = not is_link and stat.S_ISDIR(entry_info.st_mode)
        if _should_preserve_desktop_runtime(entry.name, is_dir):
            continue
        expected_kind = expected.get(_entry_compare_key(entry.name))
        if is_link or expected_kind is None or (expected_kind == 'dir') != is_dir:
            _remove_path(entry)


@lifecycle_operation
def install(panel_only=False, legacy_loader=False, instance='all'):
    _validate_instance(instance)
    if instance in ('all', 'pro'):
        own_plugin()
        config = json_read(CONFIG)
        if not isinstance(config, dict) or not isinstance(config.get('plugins', {}), dict):
            raise RuntimeError('Existing customization configuration has an incompatible shape.')
        if not panel_only:
            if not APP.is_file():
                raise RuntimeError('Antigravity desktop app not found. Use --app-path /path/to/resources/app.asar for a custom installation. See COMPATIBILITY.md.')
        if legacy_loader:
            if sys.platform != 'win32':
                raise RuntimeError('The historical app.asar loader is Windows-only. Use the default runtime adapter.')
            module = adapter()
            module.build(module.unpatched_original(APP.read_bytes()))
        elif not panel_only:
            remove_verified_legacy_adapter()

    vp = vertex_paths()
    install_vertex = instance in ('all', 'vertex') and (vp['plugin'].parent.exists() or instance == 'vertex')
    if install_vertex:
        own_plugin(vp['plugin'], vp['home'])

    destinations = []
    if instance in ('all', 'pro'):
        destinations.append(PLUGIN)
    if install_vertex:
        destinations.append(vp['plugin'])

    local_accounts = SOURCE / '.data' / 'usage-accounts.local.json'
    for dest in destinations:
        dest.mkdir(parents=True, exist_ok=True)
        for name in RUNTIME_FILES:
            source, target = SOURCE / name, dest / name
            if source.resolve() == target.resolve():
                continue
            _sync_runtime_tree(source, target, name)
        stray_lock = dest / '.antigravity-pulse-update.lock'
        if SOURCE.resolve() != dest.resolve() and stray_lock.exists() and not _is_reparse_or_symlink(stray_lock) and stray_lock.is_file():
            try:
                stray_lock.unlink(missing_ok=True)
            except OSError:
                pass
        if local_accounts.is_file():
            target_accounts = dest / '.data' / 'usage-accounts.local.json'
            if local_accounts.resolve() != target_accounts.resolve():
                target_accounts.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(local_accounts, target_accounts)
        print(f'Installed runtime files to: {dest}')

    if instance in ('all', 'pro'):
        if legacy_loader:
            subprocess.run([sys.executable, str(SOURCE / 'compat' / 'patch-loader.py'), '--apply'], check=True,
                           env={**os.environ, 'AG_PULSE_APP_ASAR': str(APP)})
        settings = json_read(SETTINGS)
        settings.update({'inline': not panel_only, 'mode': 'legacy' if legacy_loader else 'runtime'})
        if APP.is_file():
            settings['appResources'] = str(APP.parent)
        if os.environ.get('AG_PULSE_PROFILE'):
            settings['profile'] = str(_paths['profile'])
        atomic_json(SETTINGS, settings)
        _update_instance_enabled(True, PLUGIN, HOME, CONFIG, SETTINGS)
        guard_duplicate_plugins(PLUGIN, CONFIG)
        print('Installed to Pro instance:', PLUGIN)

    if install_vertex:
        if vp['config'].parent.exists():
            v_conf = json_read(vp['config'])
            v_entry = v_conf.setdefault('plugins', {}).setdefault('antigravity-pulse', {})
            v_entry['enabled'] = True
            atomic_json(vp['config'], v_conf)
            guard_duplicate_plugins(vp['plugin'], vp['config'])
        if vp['data'].exists() or vp['settings'].exists():
            v_settings = json_read(vp['settings'])
            v_settings.update({'inline': not panel_only, 'mode': 'runtime', 'enabled': True})
            atomic_json(vp['settings'], v_settings)
        print('Installed to Vertex instance:', vp['plugin'])

    print('Fully quit and reopen Antigravity to start the plugin runtime. App updates no longer overwrite the inline adapter.')

@lifecycle_operation
def uninstall(instance='all'):
    _validate_instance(instance)
    if instance in ('all', 'pro'):
        own_plugin()
        # Restore before deleting the runtime. An unknown archive is never overwritten.
        if APP.exists():
            module = adapter()
            current = APP.read_bytes()
            original = original_for_current(current)
            if original is not None:
                APP.write_bytes(original)
                if APP.read_bytes() != original:
                    raise RuntimeError('Restored application verification failed.')
                print('Original Antigravity archive restored.')
            elif b'// AG_PULSE_INLINE_V1' in current:
                header, base = module.archive(current)
                entry = header['files']['dist']['files']['preload.js']
                preload = current[base + int(entry['offset']):base + int(entry['offset']) + entry['size']]
                if module.MARKER.encode() in preload:
                    raise RuntimeError('Application changed since patching. Inspect the backup before uninstalling.')
        if PLUGIN.exists():
            _update_instance_enabled(False, PLUGIN, HOME, CONFIG, SETTINGS)
            _remove_plugin_dir(PLUGIN, HOME)
        else:
            atomic_json(SETTINGS, {'enabled': False})
    if instance in ('all', 'vertex'):
        vp = vertex_paths()
        own_plugin(vp['plugin'], vp['home'])
        if vp['plugin'].exists():
            _update_instance_enabled(False, vp['plugin'], vp['home'], vp['config'], vp['settings'], vp['data'])
            _remove_plugin_dir(vp['plugin'], vp['home'])
        elif vp['settings'].exists():
            atomic_json(vp['settings'], {'enabled': False})
    print('Antigrative Dashboard removed. Backups and diagnostic logs are retained for recovery.')
    print('Fully quit and reopen Antigravity to unload the UI adapter.')

def status(instance='all'):
    _validate_instance(instance)
    pro_installed = (PLUGIN / 'plugin.json').is_file()
    pro_enabled = pro_installed and json_read(CONFIG).get('plugins', {}).get('antigravity-pulse', {}).get('enabled', True)
    pro_health_file = HOME / '.gemini' / 'antigravity' / 'sidecar_data' / 'antigravity-pulse' / 'panel' / 'data' / 'integration-state.json'
    pro_payload = {
        'installed': pro_installed,
        'enabled': bool(pro_enabled),
        'pluginDirectory': str(PLUGIN),
        'integrationMode': json_read(SETTINGS).get('mode', 'legacy'),
        'inlineIntegration': json_read(pro_health_file, None),
        'toolbarAdapterRecoverable': APP.exists() and original_for_current(APP.read_bytes()) is not None,
    }
    vp = vertex_paths()
    v_installed = (vp['plugin'] / 'plugin.json').is_file()
    v_enabled = v_installed and json_read(vp['config']).get('plugins', {}).get('antigravity-pulse', {}).get('enabled', True)
    v_payload = {
        'installed': v_installed,
        'enabled': bool(v_enabled),
        'pluginDirectory': str(vp['plugin']),
        'integrationMode': json_read(vp['settings']).get('mode', 'runtime' if v_installed else 'legacy'),
        'inlineIntegration': json_read(vp['health'], None),
    }
    payload = {**(v_payload if instance == 'vertex' else pro_payload), 'vertex': v_payload}
    print(json.dumps(payload, indent=2))
    return payload

def _write_zip_entry(bundle, file, arc_rel):
    arcname = (Path('antigrative-dashboard') / arc_rel).as_posix()
    rel_posix = arc_rel.as_posix()
    if rel_posix.endswith('.sh') or (rel_posix in RELEASE_NATIVE_ALLOWED and rel_posix.startswith('cli/bin/') and not rel_posix.endswith('.exe')):
        info = zipfile.ZipInfo.from_file(file, arcname)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o100755 << 16)
        bundle.writestr(info, file.read_bytes())
    else:
        bundle.write(file, arcname)


def package(output=None, require_native=None):
    if require_native is None:
        require_native = os.environ.get('AG_PULSE_REQUIRE_NATIVE') == '1'
    if require_native:
        missing_native = [rel for rel in sorted(RELEASE_NATIVE_ALLOWED) if not (SOURCE / rel).is_file()]
        if missing_native:
            raise RuntimeError('Missing required native release binaries: ' + ', '.join(missing_native))
    version = json_read(SOURCE / 'plugin.json')['version']
    output = Path(output) if output else SOURCE / 'dist' / f'antigrative-dashboard-{version}.zip'
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in DIST_FILES:
            path = SOURCE / name
            if not path.exists():
                raise RuntimeError(f'Required release file missing: {name}')
            files = sorted(path.rglob('*')) if path.is_dir() else [path]
            for file in files:
                rel_path = file.relative_to(SOURCE)
                rel_parts = rel_path.parts
                rel_posix = rel_path.as_posix()
                if not file.is_file():
                    continue
                if rel_posix not in RELEASE_NATIVE_ALLOWED:
                    if any(p in IGNORED for p in rel_parts) or rel_parts[:2] == ('cli', 'bin'):
                        continue
                    if file.suffix.lower() in {'.log', '.pyc', '.node', '.dll', '.so', '.dylib', '.pdb', '.exp', '.exe', '.lib'}:
                        continue
                _write_zip_entry(bundle, file, rel_path)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n', encoding='utf-8')
    print('Package:', output)
    print('SHA256:', digest)

def main():
    global APP
    parser = argparse.ArgumentParser(description='Antigrative Dashboard lifecycle manager')
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('install'); group = p.add_mutually_exclusive_group()
    group.add_argument('--panel-only', action='store_true')
    group.add_argument('--legacy-loader', action='store_true', help='Opt in to the old, version-specific app.asar adapter')
    p.add_argument('--instance', choices=('all', 'pro', 'vertex'), default='all', help='Target instance for installation (default: all)')
    p.add_argument('--app-path', type=Path, help='Path to the desktop app resources/app.asar for a custom installation')
    for action in ('enable', 'disable', 'status', 'uninstall'):
        sub.add_parser(action).add_argument('--instance', choices=('all', 'pro', 'vertex'), default='all', help='Target instance (default: all)')
    p = sub.add_parser('install-cli', help='Install the official CLI statusLine adapter independently of desktop')
    p.add_argument('--node', help='Node.js 20+ executable (defaults to PATH)')
    p.add_argument('--language', choices=('en', 'zh-CN'), help='Override shared desktop language choice')
    for action in ('uninstall-cli', 'status-cli'): sub.add_parser(action)
    p = sub.add_parser('package'); p.add_argument('--output'); p.add_argument('--require-native', action='store_true')
    args = parser.parse_args()
    if args.action == 'install' and args.app_path:
        APP = args.app_path.expanduser().resolve()
    try:
        if args.action in ('install-cli', 'uninstall-cli', 'status-cli'):
            spec = importlib.util.spec_from_file_location('pulse_cli_lifecycle', SOURCE / 'cli' / 'lifecycle.py')
            cli = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cli)
            if args.action == 'install-cli': cli.install(SOURCE, HOME, args.node, args.language)
            elif args.action == 'uninstall-cli': cli.uninstall(HOME)
            else: cli.status(HOME)
            return 0
        if args.action == 'install': install(args.panel_only, args.legacy_loader, args.instance)
        elif args.action == 'enable': set_enabled(True, args.instance)
        elif args.action == 'disable': set_enabled(False, args.instance)
        elif args.action == 'uninstall': uninstall(args.instance)
        elif args.action == 'status': status(args.instance)
        elif args.action == 'package': package(args.output, True if args.require_native else None)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Antigrative Dashboard: {error}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
