import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pulse_manager', ROOT / 'manage.py')
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.local = self.home / 'AppData' / 'Local'
        self.plugin = self.home / '.gemini' / 'config' / 'plugins' / 'antigravity-pulse'
        self.config = self.home / '.gemini' / 'config' / 'config.json'
        self.settings = self.local / 'AntigravityPulse' / 'settings.json'
        self.app = self.local / 'Programs' / 'antigravity' / 'resources' / 'app.asar'
        self.backups = self.local / 'AntigravityPulseBackups'
        self.context = patch.multiple(manager, HOME=self.home, LOCAL=self.local, PLUGIN=self.plugin,
                                      CONFIG=self.config, SETTINGS=self.settings, APP=self.app, BACKUPS=self.backups)
        self.context.start()
        self.addCleanup(self.context.stop)

    def test_panel_install_disable_enable_remove_preserves_other_settings(self):
        manager.atomic_json(self.config, {'other': {'keep': 1}, 'plugins': {'other-plugin': {'enabled': True}}})
        manager.install(panel_only=True)
        self.assertTrue((self.plugin / 'sidecars' / 'panel' / 'main.mjs').exists())
        manager.set_enabled(False)
        self.assertFalse(manager.json_read(self.settings)['enabled'])
        manager.set_enabled(True)
        self.assertTrue(manager.json_read(self.settings)['enabled'])
        manager.uninstall()
        self.assertFalse(self.plugin.exists())
        self.assertFalse(manager.json_read(self.settings)['enabled'])
        config = manager.json_read(self.config)
        self.assertEqual(config['other'], {'keep': 1})
        self.assertTrue(config['plugins']['other-plugin']['enabled'])

    def test_app_lifecycle_respects_active_update_and_recovery_journal(self):
        lock_spec=importlib.util.spec_from_file_location('test_update_lock', ROOT/'compat/update-lock.py')
        locks=importlib.util.module_from_spec(lock_spec);lock_spec.loader.exec_module(locks)
        with locks.lifecycle_lock(self.plugin):
            with self.assertRaises(FileExistsError):manager.install(panel_only=True)
            with self.assertRaises(FileExistsError):manager.uninstall()
        journal=self.plugin.parent/'.antigravity-pulse-update-transaction/journal.json'
        journal.parent.mkdir();journal.write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'recovery'):manager.install(panel_only=True)
        with self.assertRaisesRegex(RuntimeError,'recovery'):manager.uninstall()

    def test_other_plugin_is_not_overwritten_or_removed(self):
        self.plugin.mkdir(parents=True)
        manager.atomic_json(self.plugin / 'plugin.json', {'name': 'different'})
        with self.assertRaises(RuntimeError): manager.install(panel_only=True)
        with self.assertRaises(RuntimeError): manager.uninstall()
        self.assertEqual(manager.json_read(self.plugin / 'plugin.json')['name'], 'different')

    def test_uninstall_restores_only_the_exact_verified_archive(self):
        self.plugin.mkdir(parents=True)
        manager.atomic_json(self.plugin / 'plugin.json', {'name': 'antigravity-pulse'})
        self.app.parent.mkdir(parents=True)
        self.app.write_bytes(b'patched-fixture')
        backup = self.backups / 'test-backup'
        backup.mkdir(parents=True)
        (backup / 'app.asar').write_bytes(b'original-fixture')
        manager.atomic_json(backup / 'patch.json', {'patchedSha256': hashlib.sha256(b'patched-fixture').hexdigest(),
                                                  'originalSha256': hashlib.sha256(b'original-fixture').hexdigest()})
        manager.uninstall()
        self.assertEqual(self.app.read_bytes(), b'original-fixture')
        self.assertTrue(backup.exists())

    def test_unknown_app_changes_block_uninstall_before_deleting_plugin(self):
        self.plugin.mkdir(parents=True)
        manager.atomic_json(self.plugin / 'plugin.json', {'name': 'antigravity-pulse'})
        self.app.parent.mkdir(parents=True)
        changed = b'changed-by-another-application // AG_PULSE_INLINE_V1'
        self.app.write_bytes(changed)
        with self.assertRaises(Exception): manager.uninstall()
        self.assertTrue(self.plugin.exists())
        self.assertEqual(self.app.read_bytes(), changed)

    def test_default_install_and_upgrade_do_not_modify_the_application(self):
        self.app.parent.mkdir(parents=True)
        for archive in [b'future-host-build-without-legacy-patch', b'newer-host-build-after-auto-update']:
            self.app.write_bytes(archive)
            manager.install()
            self.assertEqual(self.app.read_bytes(), archive)
            self.assertEqual(manager.json_read(self.settings)['mode'], 'runtime')
            self.assertTrue(manager.json_read(self.settings)['inline'])
        self.assertTrue((self.plugin / 'compat' / 'runtime-ui.mjs').is_file())

    def test_switches_preserve_runtime_settings(self):
        manager.install(panel_only=True)
        manager.atomic_json(self.settings, {'enabled': True, 'inline': False, 'mode': 'runtime', 'custom': 123})
        manager.set_enabled(False)
        manager.set_enabled(True)
        self.assertEqual(manager.json_read(self.settings), {'enabled': True, 'inline': False, 'mode': 'runtime', 'custom': 123})

    def test_default_migration_refuses_unknown_legacy_edits_before_copying(self):
        self.app.parent.mkdir(parents=True)
        self.app.write_bytes(b'unknown-modifications // AG_PULSE_INLINE_V1')
        with self.assertRaises(RuntimeError): manager.install()
        self.assertFalse(self.plugin.exists())
        self.assertEqual(self.app.read_bytes(), b'unknown-modifications // AG_PULSE_INLINE_V1')

    def test_release_uses_allowlist_and_excludes_private_runtime_files(self):
        output = self.home / 'release.zip'
        manager.package(output)
        with zipfile.ZipFile(output) as bundle:
            names = bundle.namelist()
            self.assertIn('antigrative-dashboard/manage.py', names)
            self.assertIn('antigrative-dashboard/LICENSE', names)
            self.assertFalse(any(name.endswith(('.log', '.asar', '.pyc')) for name in names))
            self.assertFalse(any('/.git/' in name or '/__pycache__/' in name for name in names))
        self.assertTrue(output.with_suffix('.zip.sha256').exists())

    def test_history_and_sdk_records_are_excluded_even_if_inside_source(self):
        source = self.home / 'fixture-source'
        manager.atomic_json(source / 'plugin.json', {'version': 'test'})
        panel = source / 'sidecars' / 'panel'
        panel.mkdir(parents=True)
        (panel / 'main.mjs').write_text('// public runtime')
        manager.atomic_json(panel / 'data' / 'history-v1' / 'account' / 'conversation.json', {'private': 'statistics'})
        manager.atomic_json(panel / 'sdk' / 'private.json', {'private': 'host SDK'})
        output = self.home / 'private-exclusion.zip'
        with patch.multiple(manager, SOURCE=source, DIST_FILES=('plugin.json', 'sidecars')):
            manager.package(output)
        with zipfile.ZipFile(output) as bundle:
            self.assertEqual(set(bundle.namelist()), {'antigrative-dashboard/plugin.json', 'antigrative-dashboard/sidecars/panel/main.mjs'})

    def test_symmetric_pro_and_vertex_lifecycle(self):
        vp = manager.vertex_paths()
        vp['plugin'].parent.mkdir(parents=True)
        vp['data'].mkdir(parents=True)
        manager.atomic_json(vp['config'], {'other': {'keep': 2}, 'plugins': {'other-vertex': {'enabled': True}}})

        manager.install(panel_only=True)
        self.assertTrue((self.plugin / 'sidecars' / 'panel' / 'main.mjs').is_file())
        self.assertTrue((vp['plugin'] / 'sidecars' / 'panel' / 'main.mjs').is_file())
        self.assertTrue(manager.json_read(self.config)['plugins']['antigravity-pulse']['enabled'])
        self.assertTrue(manager.json_read(vp['config'])['plugins']['antigravity-pulse']['enabled'])
        self.assertTrue(manager.json_read(vp['settings'])['enabled'])

        both_on = manager.status()
        self.assertTrue(both_on['installed'])
        self.assertTrue(both_on['enabled'])
        self.assertTrue(both_on['vertex']['installed'])
        self.assertTrue(both_on['vertex']['enabled'])
        self.assertEqual(both_on['vertex']['pluginDirectory'], str(vp['plugin']))
        self.assertEqual(both_on['vertex']['integrationMode'], 'runtime')

        manager.set_enabled(False)
        self.assertFalse(manager.json_read(self.config)['plugins']['antigravity-pulse']['enabled'])
        self.assertFalse(manager.json_read(self.settings)['enabled'])
        self.assertFalse(manager.json_read(vp['config'])['plugins']['antigravity-pulse']['enabled'])
        self.assertFalse(manager.json_read(vp['settings'])['enabled'])
        self.assertFalse(manager.status()['vertex']['enabled'])

        manager.set_enabled(True)
        self.assertTrue(manager.json_read(self.config)['plugins']['antigravity-pulse']['enabled'])
        self.assertTrue(manager.json_read(self.settings)['enabled'])
        self.assertTrue(manager.json_read(vp['config'])['plugins']['antigravity-pulse']['enabled'])
        self.assertTrue(manager.json_read(vp['settings'])['enabled'])
        vertex_only_status = manager.status(instance='vertex')
        self.assertTrue(vertex_only_status['installed'])
        self.assertTrue(vertex_only_status['enabled'])
        self.assertEqual(vertex_only_status['pluginDirectory'], str(vp['plugin']))
        self.assertTrue(vertex_only_status['vertex']['enabled'])

        manager.uninstall()
        self.assertFalse(self.plugin.exists())
        self.assertFalse(vp['plugin'].exists())
        self.assertFalse(manager.json_read(self.settings)['enabled'])
        self.assertFalse(manager.json_read(vp['settings'])['enabled'])
        self.assertFalse(manager.json_read(vp['config'])['plugins']['antigravity-pulse']['enabled'])
        self.assertEqual(manager.json_read(vp['config'])['other'], {'keep': 2})
        self.assertTrue(manager.json_read(vp['config'])['plugins']['other-vertex']['enabled'])

    def test_instance_targeted_lifecycle_and_local_accounts_deploy(self):
        source = self.home / 'fixture-source'
        for sub in ('assets', 'compat', 'sidecars/panel'):
            (source / sub).mkdir(parents=True)
        (source / 'compat' / 'update-lock.py').write_text((ROOT / 'compat' / 'update-lock.py').read_text(encoding='utf-8'), encoding='utf-8')
        (source / 'sidecars' / 'panel' / 'main.mjs').write_text('// panel')
        manager.atomic_json(source / 'plugin.json', {'name': 'antigravity-pulse', 'version': '0.10.1'})
        manager.atomic_json(source / '.data' / 'usage-accounts.local.json', {'hash1': {'email': 'a@example.test', 'primary': True}})

        vp = manager.vertex_paths()
        vp['plugin'].parent.mkdir(parents=True)
        with patch.multiple(manager, SOURCE=source):
            manager.install(panel_only=True)
            self.assertEqual(manager.json_read(self.plugin / '.data' / 'usage-accounts.local.json')['hash1']['email'], 'a@example.test')
            self.assertEqual(manager.json_read(vp['plugin'] / '.data' / 'usage-accounts.local.json')['hash1']['email'], 'a@example.test')

        manager.set_enabled(False, instance='vertex')
        self.assertTrue(manager.json_read(self.config)['plugins']['antigravity-pulse']['enabled'])
        self.assertFalse(manager.json_read(vp['config'])['plugins']['antigravity-pulse']['enabled'])

        manager.uninstall(instance='vertex')
        self.assertTrue(self.plugin.exists())
        self.assertFalse(vp['plugin'].exists())

    def test_desktop_install_excludes_dev_files_prunes_stale_and_preserves_data(self):
        source = self.home / 'fixture-source'
        for sub in ('assets', 'compat', 'sidecars/panel/tests', 'sidecars/panel/__pycache__'):
            (source / sub).mkdir(parents=True)
        (source / 'compat' / 'update-lock.py').write_text((ROOT / 'compat' / 'update-lock.py').read_text(encoding='utf-8'), encoding='utf-8')
        (source / 'assets' / 'logo.svg').write_text('<svg/>', encoding='utf-8')
        (source / 'sidecars' / 'panel' / 'main.mjs').write_text('// panel v2', encoding='utf-8')
        (source / 'sidecars' / 'panel' / 'pulse-accel.node').write_bytes(b'native-addon')
        (source / 'sidecars' / 'panel' / 'toolbar-preview.html').write_text('<html>preview</html>', encoding='utf-8')
        (source / 'sidecars' / 'panel' / 'tests' / 'sample.test.mjs').write_text('// test', encoding='utf-8')
        (source / 'sidecars' / 'panel' / '__pycache__' / 'x.pyc').write_bytes(b'pyc')
        manager.atomic_json(source / 'plugin.json', {'name': 'antigravity-pulse', 'version': '0.12.5'})
        manager.atomic_json(source / '.data' / 'usage-accounts.local.json', {'acct1': {'email': 'a@example.test'}})

        # Pre-populate target with stale files, leaked tests/preview, stray inner lock, and preserved data
        for sub in ('sidecars/panel/tests', 'sidecars/panel/data', 'sidecars/panel/history-v1', '.data'):
            (self.plugin / sub).mkdir(parents=True)
        manager.atomic_json(self.plugin / 'plugin.json', {'name': 'antigravity-pulse', 'version': '0.12.4'})
        (self.plugin / 'sidecars' / 'panel' / 'background-worker.mjs').write_text('// stale', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'usage-disk-worker.mjs').write_text('// stale', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'sidebar-preview.html').write_text('<html>stale</html>', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'toolbar-preview.html').write_text('<html>leaked</html>', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'tests' / 'old.test.mjs').write_text('// leaked', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'data' / 'legacy.json').write_text('{"keep":true}', encoding='utf-8')
        (self.plugin / 'sidecars' / 'panel' / 'history-v1' / 'conv.json').write_text('{"keep":true}', encoding='utf-8')
        (self.plugin / '.data' / 'custom-state.json').write_text('{"keep":true}', encoding='utf-8')
        (self.plugin / '.antigravity-pulse-update.lock').write_text('0', encoding='utf-8')

        with patch.multiple(manager, SOURCE=source):
            manager.install(panel_only=True, instance='pro')

        self.assertEqual((self.plugin / 'sidecars' / 'panel' / 'main.mjs').read_text(encoding='utf-8'), '// panel v2')
        self.assertEqual((self.plugin / 'sidecars' / 'panel' / 'pulse-accel.node').read_bytes(), b'native-addon')
        self.assertEqual(manager.json_read(self.plugin / 'plugin.json')['version'], '0.12.5')
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / 'tests').exists())
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / 'toolbar-preview.html').exists())
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / '__pycache__').exists())
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / 'background-worker.mjs').exists())
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / 'usage-disk-worker.mjs').exists())
        self.assertFalse((self.plugin / 'sidecars' / 'panel' / 'sidebar-preview.html').exists())
        self.assertFalse((self.plugin / '.antigravity-pulse-update.lock').exists())
        self.assertEqual((self.plugin / '.data' / 'custom-state.json').read_text(encoding='utf-8'), '{"keep":true}')
        self.assertEqual(manager.json_read(self.plugin / '.data' / 'usage-accounts.local.json')['acct1']['email'], 'a@example.test')
        self.assertEqual((self.plugin / 'sidecars' / 'panel' / 'data' / 'legacy.json').read_text(encoding='utf-8'), '{"keep":true}')
        self.assertEqual((self.plugin / 'sidecars' / 'panel' / 'history-v1' / 'conv.json').read_text(encoding='utf-8'), '{"keep":true}')

    def test_sync_runtime_tree_handles_live_and_broken_junctions_without_touching_targets(self):
        import subprocess
        def make_dir_link(link_path, target_path):
            if os.name == 'nt':
                subprocess.run(['cmd', '/c', 'mklink', '/J', str(link_path), str(target_path)],
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                os.symlink(target_path, link_path, target_is_directory=True)

        src = self.home / 'link-src'
        dst = self.home / 'link-dst'
        external = self.home / 'external-target'
        external_replace = self.home / 'external-replace'
        broken_target = self.home / 'broken-target'

        (src / 'sub').mkdir(parents=True)
        (src / 'main.mjs').write_text('// real file', encoding='utf-8')
        (src / 'sub' / 'item.mjs').write_text('// real sub', encoding='utf-8')
        external.mkdir()
        (external / 'secret.txt').write_text('do-not-delete', encoding='utf-8')
        external_replace.mkdir()
        (external_replace / 'keep.txt').write_text('still-intact', encoding='utf-8')
        broken_target.mkdir()

        (dst / 'stale-dir').mkdir(parents=True)
        make_dir_link(dst / 'stale-link', external)
        make_dir_link(dst / 'stale-dir' / 'nested-link', external)
        make_dir_link(dst / 'sub', external_replace)
        make_dir_link(dst / 'main.mjs', broken_target)
        make_dir_link(dst / 'broken-stale', broken_target)
        broken_target.rmdir()

        external_file = self.home / 'external-file.txt'
        external_file.write_text('untouched-external-file', encoding='utf-8')
        file_symlink_created = False
        try:
            (src / 'file-target.mjs').write_text('// fresh file', encoding='utf-8')
            os.symlink(external_file, dst / 'file-target.mjs')
            file_symlink_created = True
        except OSError:
            (src / 'file-target.mjs').unlink(missing_ok=True)

        single_src = self.home / 'plugin.json'
        single_dst = self.home / 'plugin-dst.json'
        single_src.write_text('{"name":"antigravity-pulse"}\n', encoding='utf-8')
        broken_single = self.home / 'broken-single'
        broken_single.mkdir()
        make_dir_link(single_dst, broken_single)
        broken_single.rmdir()

        manager._sync_runtime_tree(src, dst, 'sidecars')
        manager._sync_runtime_tree(single_src, single_dst, 'plugin.json')

        self.assertEqual((dst / 'main.mjs').read_text(encoding='utf-8'), '// real file')
        self.assertFalse(manager._is_reparse_or_symlink(dst / 'main.mjs'))
        self.assertEqual((dst / 'sub' / 'item.mjs').read_text(encoding='utf-8'), '// real sub')
        self.assertFalse(manager._is_reparse_or_symlink(dst / 'sub'))
        self.assertEqual(single_dst.read_text(encoding='utf-8'), '{"name":"antigravity-pulse"}\n')
        self.assertFalse(manager._is_reparse_or_symlink(single_dst))

        self.assertFalse(os.path.lexists(dst / 'stale-link'))
        self.assertFalse(os.path.lexists(dst / 'stale-dir'))
        self.assertFalse(os.path.lexists(dst / 'broken-stale'))

        # External targets must remain untouched
        self.assertEqual((external / 'secret.txt').read_text(encoding='utf-8'), 'do-not-delete')
        self.assertEqual((external_replace / 'keep.txt').read_text(encoding='utf-8'), 'still-intact')
        self.assertFalse((external_replace / 'item.mjs').exists())
        if file_symlink_created:
            self.assertEqual((dst / 'file-target.mjs').read_text(encoding='utf-8'), '// fresh file')
            self.assertFalse(manager._is_reparse_or_symlink(dst / 'file-target.mjs'))
            self.assertEqual(external_file.read_text(encoding='utf-8'), 'untouched-external-file')

if __name__ == '__main__': unittest.main()
