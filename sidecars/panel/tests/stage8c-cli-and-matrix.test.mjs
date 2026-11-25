import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as manifest from '../../../src/platform/manifest.ts';
import { isExcludedFromOpenSource } from '../../../src/lifecycle/sanitizer.ts';
import {
  packageDesktopRelease,
  packageIdeVsix,
  verifyReleaseAssets,
} from '../../../src/lifecycle/packager.ts';
import { readZipArchive } from '../../../src/shared/zip.ts';
import {
  NATIVE_TARGET_MATRIX,
  parseBuildArgs,
  resolveNativeTargetSpec,
} from '../../../tools/build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('manifest.ts, sanitizer.ts, export-opensource.py, and .gitignore exclude native binaries and docs/internal', () => {
  const excludedSamples = [
    'sidecars/panel/pulse-accel.node',
    'sidecars/panel/pulse-accel.win32-x64.node',
    'sidecars/panel/pulse-accel.darwin-arm64.node',
    'cli/bin/ag-pulse-statusline',
    'cli/bin/ag-pulse-statusline.exe',
    'cli/bin/ag-pulse-statusline.darwin-arm64',
    'ag-pulse-statusline',
    'native/pulse-accel/target/release/pulse_accel.pdb',
    'native/pulse-accel/target/release/ag-pulse-statusline.exe',
    'docs/internal/STAGE8B_8C_ENGINEERING_BLUEPRINT.md',
  ];
  const keptSamples = [
    'native/pulse-accel/Cargo.toml',
    'native/pulse-accel/src/bin/statusline.rs',
    'tools/build.mjs',
    'cli/statusline.mjs',
    '.github/workflows/native.yml',
  ];

  for (const rel of excludedSamples) {
    assert.equal(isExcludedFromOpenSource(rel), true, `Expected sanitizer to exclude ${rel}`);
  }
  for (const rel of keptSamples) {
    assert.equal(isExcludedFromOpenSource(rel), false, `Expected sanitizer to keep ${rel}`);
  }

  for (const suffix of ['.node', '.exe', '.pdb', '.dll', '.so', '.dylib', '.exp']) {
    assert.ok(manifest.PACKAGER_IGNORED_SUFFIXES.has(suffix), `PACKAGER_IGNORED_SUFFIXES missing ${suffix}`);
    assert.ok(manifest.OPENSOURCE_EXCLUDED_SUFFIXES.has(suffix), `OPENSOURCE_EXCLUDED_SUFFIXES missing ${suffix}`);
  }
  for (const name of ['internal', 'target', 'ag-pulse-statusline', 'ag-pulse-statusline.exe']) {
    assert.ok(manifest.PACKAGER_IGNORED_NAMES.has(name), `PACKAGER_IGNORED_NAMES missing ${name}`);
  }
  for (const dir of ['internal', 'target']) {
    assert.ok(manifest.OPENSOURCE_EXCLUDED_DIRS.has(dir), `OPENSOURCE_EXCLUDED_DIRS missing ${dir}`);
  }

  const exportPyPath = join(ROOT, 'tools', 'export-opensource.py');
  if (existsSync(exportPyPath)) {
    const pySrc = readFileSync(exportPyPath, 'utf8');
    for (const token of ["'.exe'", "'.node'", "'.pdb'", "'internal'", "'cli/bin/ag-pulse-statusline'"]) {
      assert.ok(pySrc.includes(token), `export-opensource.py missing ${token}`);
    }

    // Verify Python is_excluded agrees with TS isExcludedFromOpenSource
    const pyCheckScript = [
      'import importlib.util, json, sys',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location('eo', ${JSON.stringify(exportPyPath)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      `samples = json.loads(${JSON.stringify(JSON.stringify([...excludedSamples, ...keptSamples]))})`,
      'print(json.dumps({s: mod.is_excluded(Path(s)) for s in samples}))',
    ].join('\n');
    const pyExe = process.platform === 'win32' ? 'python' : 'python3';
    const pyResult = JSON.parse(execFileSync(pyExe, ['-c', pyCheckScript], { encoding: 'utf8' }));
    for (const rel of excludedSamples) {
      assert.equal(pyResult[rel], true, `export-opensource.py should exclude ${rel}`);
    }
    for (const rel of keptSamples) {
      assert.equal(pyResult[rel], false, `export-opensource.py should keep ${rel}`);
    }
  }

  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const line of ['cli/bin/', '*.node', '*.exe', '*.pdb', 'docs/internal/', 'native/pulse-accel/target/']) {
    assert.ok(gitignore.includes(line), `.gitignore missing ${line}`);
  }
});

test('packager includes tagged cross-platform native binaries while excluding untagged dev binaries and docs/internal', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ag-stage8c-pkg-'));
  try {
    for (const rel of manifest.DIST_RELEASE_FILES) {
      if (['plugin.json', 'mcp_config.json', 'manage.mjs', 'manage.py', 'install.ps1', 'uninstall.ps1', 'install.sh', 'uninstall.sh', 'README.md', 'LICENSE', 'CHANGELOG.md', 'COMPATIBILITY.md', 'package.json', '.gitignore', '.gitattributes', 'GITHUB_RELEASE.md', 'README.zh-CN.md'].includes(rel)) {
        writeFileSync(join(tmp, rel), rel === 'plugin.json' ? '{"name":"antigravity-pulse","version":"0.0.1-test"}\n' : 'ok\n');
      } else {
        mkdirSync(join(tmp, rel), { recursive: true });
      }
    }
    mkdirSync(join(tmp, 'sidecars', 'panel'), { recursive: true });
    writeFileSync(join(tmp, 'sidecars', 'panel', 'pulse-accel.node'), 'untagged-dev-binary');
    for (const relAddon of manifest.RELEASE_NATIVE_ADDONS) {
      writeFileSync(join(tmp, relAddon), `addon:${relAddon}`);
    }
    writeFileSync(join(tmp, 'sidecars', 'panel', 'main.mjs'), '// ok\n');
    mkdirSync(join(tmp, 'cli', 'bin'), { recursive: true });
    writeFileSync(join(tmp, 'cli', 'bin', 'ag-pulse-statusline'), 'untagged-elf');
    writeFileSync(join(tmp, 'cli', 'bin', 'ag-pulse-statusline.exe'), 'untagged-exe');
    for (const relCli of manifest.RELEASE_NATIVE_CLI_BINS) {
      writeFileSync(join(tmp, relCli), `cli:${relCli}`);
    }
    writeFileSync(join(tmp, 'cli', 'statusline.mjs'), '// ok\n');
    mkdirSync(join(tmp, 'docs', 'internal'), { recursive: true });
    writeFileSync(join(tmp, 'docs', 'internal', 'secret.md'), 'internal');
    writeFileSync(join(tmp, 'sidecars', 'panel', 'debug.pdb'), 'pdb');
    for (const reqZip of manifest.RELEASE_ZIP_REQUIRED_FILES) {
      const target = join(tmp, reqZip);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, '// required\n');
    }

    mkdirSync(join(tmp, 'ide'), { recursive: true });
    writeFileSync(
      join(tmp, 'ide', 'package.json'),
      JSON.stringify({ name: manifest.IDE_PACKAGE_NAME, publisher: manifest.IDE_PUBLISHER, version: '0.0.1-test', engines: { vscode: '*' } }),
    );
    for (const relStatic of manifest.IDE_VSIX_STATIC_FILES) {
      const target = join(tmp, relStatic);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, 'doc\n');
    }
    for (const relMod of manifest.IDE_VSIX_MODULES) {
      const target = join(tmp, relMod);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, '// mod\n');
    }

    const outZip = join(tmp, 'dist', 'antigrative-dashboard-0.0.1-test.zip');
    packageDesktopRelease(tmp, outZip, { requireNative: true });
    const entries = readZipArchive(readFileSync(outZip));
    const names = [...entries.keys()];
    assert.ok(names.includes('antigrative-dashboard/sidecars/panel/main.mjs'));
    assert.ok(names.includes('antigrative-dashboard/cli/statusline.mjs'));
    for (const relNative of [...manifest.RELEASE_NATIVE_ADDONS, ...manifest.RELEASE_NATIVE_CLI_BINS]) {
      assert.ok(names.includes(`antigrative-dashboard/${relNative}`), `ZIP missing ${relNative}`);
    }
    assert.ok(!names.includes('antigrative-dashboard/sidecars/panel/pulse-accel.node'));
    assert.ok(!names.includes('antigrative-dashboard/cli/bin/ag-pulse-statusline'));
    assert.ok(!names.includes('antigrative-dashboard/cli/bin/ag-pulse-statusline.exe'));
    assert.ok(!names.some((n) => n.endsWith('.pdb')));
    assert.ok(!names.some((n) => n.includes('/docs/internal/')));

    const outVsix = join(tmp, 'dist', `${manifest.IDE_PACKAGE_NAME}-0.0.1-test.vsix`);
    packageIdeVsix(tmp, outVsix, { requireNative: true });
    const vsixEntries = readZipArchive(readFileSync(outVsix));
    const vsixNames = [...vsixEntries.keys()];
    for (const relAddon of manifest.RELEASE_NATIVE_ADDONS) {
      assert.ok(vsixNames.includes(`extension/${relAddon}`), `VSIX missing ${relAddon}`);
    }
    assert.ok(vsixEntries.get('[Content_Types].xml').readText().includes('Extension="node"'));
    verifyReleaseAssets(tmp, 'v0.0.1-test', { requireNative: true });

    // Also verify Python manage.py package() applies identical inclusion/exclusion rules.
    const pyPkgScript = [
      'import importlib.util, zipfile',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location('mp', ${JSON.stringify(join(ROOT, 'manage.py'))})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      `mod.SOURCE = Path(${JSON.stringify(tmp)})`,
      `mod.package(${JSON.stringify(join(tmp, 'py-out.zip'))}, require_native=True)`,
    ].join('\n');
    const pyExe = process.platform === 'win32' ? 'python' : 'python3';
    execFileSync(pyExe, ['-c', pyPkgScript], { encoding: 'utf8' });
    const pyEntries = readZipArchive(readFileSync(join(tmp, 'py-out.zip')));
    const pyNames = [...pyEntries.keys()];
    assert.ok(pyNames.includes('antigrative-dashboard/sidecars/panel/main.mjs'));
    for (const relNative of [...manifest.RELEASE_NATIVE_ADDONS, ...manifest.RELEASE_NATIVE_CLI_BINS]) {
      assert.ok(pyNames.includes(`antigrative-dashboard/${relNative}`), `Python ZIP missing ${relNative}`);
    }
    assert.ok(!pyNames.includes('antigrative-dashboard/sidecars/panel/pulse-accel.node'));
    assert.ok(!pyNames.includes('antigrative-dashboard/cli/bin/ag-pulse-statusline'));
    assert.ok(!pyNames.includes('antigrative-dashboard/cli/bin/ag-pulse-statusline.exe'));
    assert.ok(!pyNames.some((n) => n.endsWith('.pdb')));
    assert.ok(!pyNames.some((n) => n.includes('/docs/internal/')));

    // Removing one platform binary must fail requireNative verification.
    rmSync(join(tmp, manifest.RELEASE_NATIVE_ADDONS[0]));
    assert.throws(() => packageDesktopRelease(tmp, outZip, { requireNative: true }), /Missing required native/);
    assert.throws(() => packageIdeVsix(tmp, outVsix, { requireNative: true }), /Missing native VSIX addon/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('tools/build.mjs target matrix, Cargo.toml [[bin]], .cargo/config.toml, and native.yml stay aligned', () => {
  const parsed = parseBuildArgs(['--native-tag', '--target', 'aarch64-apple-darwin', '--native-only']);
  assert.deepEqual(parsed, {
    checkOnly: false,
    skipNative: false,
    nativeTag: true,
    nativeOnly: true,
    targetTriple: 'aarch64-apple-darwin',
  });
  assert.equal(parseBuildArgs(['--target=x86_64-unknown-linux-gnu']).targetTriple, 'x86_64-unknown-linux-gnu');
  assert.throws(() => parseBuildArgs(['--target']));
  assert.throws(() => resolveNativeTargetSpec({ targetTriple: 'unknown-target-triple' }));

  const macArm = resolveNativeTargetSpec({ targetTriple: 'aarch64-apple-darwin', platform: 'win32', arch: 'x64' });
  assert.equal(macArm.taggedNodeName, 'pulse-accel.darwin-arm64.node');
  assert.equal(macArm.taggedCliBinName, 'ag-pulse-statusline.darwin-arm64');
  assert.equal(macArm.libName, 'libpulse_accel.dylib');
  assert.equal(macArm.isHostMatch, false);

  const winX64 = resolveNativeTargetSpec({ targetTriple: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64' });
  assert.equal(winX64.taggedNodeName, 'pulse-accel.win32-x64.node');
  assert.equal(winX64.taggedCliBinName, 'ag-pulse-statusline.win32-x64.exe');
  assert.equal(winX64.isHostMatch, true);

  assert.ok(NATIVE_TARGET_MATRIX.length >= 6);

  const cargoToml = readFileSync(join(ROOT, 'native', 'pulse-accel', 'Cargo.toml'), 'utf8');
  assert.match(cargoToml, /\[\[bin\]\]/);
  assert.match(cargoToml, /name\s*=\s*"ag-pulse-statusline"/);
  assert.match(cargoToml, /path\s*=\s*"src\/bin\/statusline\.rs"/);

  const statuslineRs = readFileSync(join(ROOT, 'native', 'pulse-accel', 'src', 'bin', 'statusline.rs'), 'utf8');
  assert.match(statuslineRs, /#\[cfg\(test\)\]\s*mod tests/);

  const cargoConfig = readFileSync(join(ROOT, 'native', 'pulse-accel', '.cargo', 'config.toml'), 'utf8');
  assert.match(cargoConfig, /\[target\.x86_64-pc-windows-gnu\]/);

  const buildRs = readFileSync(join(ROOT, 'native', 'pulse-accel', 'build.rs'), 'utf8');
  assert.match(buildRs, /CARGO_CFG_TARGET_OS/);
  assert.match(buildRs, /rustc-cdylib-link-arg=-undefined/);
  assert.match(buildRs, /dynamic_lookup/);

  const nativeYml = readFileSync(join(ROOT, '.github', 'workflows', 'native.yml'), 'utf8');
  assert.match(nativeYml, /\bmacos-(?:latest|15-intel)\b/, '.github/workflows/native.yml missing macOS runner');
  for (const expected of [
    'workflow_call:',
    'windows-latest',
    'ubuntu-latest',
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-unknown-linux-gnu',
    'aarch64-unknown-linux-gnu',
    '--native-tag',
    'actions/upload-artifact@v4',
  ]) {
    assert.ok(nativeYml.includes(expected), `.github/workflows/native.yml missing ${expected}`);
  }

  const releaseYml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const expected of [
    'uses: ./.github/workflows/native.yml',
    'needs: [verify, host-resources, native]',
    'actions/download-artifact@v4',
    'pulse-native-*',
    '--require-native',
    'AG_PULSE_REQUIRE_NATIVE',
  ]) {
    assert.ok(releaseYml.includes(expected), `.github/workflows/release.yml missing ${expected}`);
  }
});

test('native ag-pulse-statusline binary matches cli/statusline.mjs output when built', (t) => {
  const binName = process.platform === 'win32' ? 'ag-pulse-statusline.exe' : 'ag-pulse-statusline';
  const nativeBin = join(ROOT, 'cli', 'bin', binName);
  if (!existsSync(nativeBin)) {
    t.skip(`${nativeBin} not built in this environment`);
    return;
  }

  const tsScript = join(ROOT, 'cli', 'statusline.mjs');
  const nativeJson = spawnSync(nativeBin, ['--preview', '--json'], { encoding: 'utf8' });
  const tsJson = spawnSync(process.execPath, [tsScript, '--preview', '--json'], { encoding: 'utf8' });
  assert.equal(nativeJson.status, 0);
  assert.deepEqual(JSON.parse(nativeJson.stdout), JSON.parse(tsJson.stdout));

  for (const args of [
    ['--preview', '--no-color', '--language', 'en'],
    ['--preview', '--no-color', '--language', 'zh-CN'],
    ['--preview', '--no-color', '--full', '--language', 'en', '--width', '100'],
    ['--preview', '--no-color', '--compact', '--language', 'en', '--width', '55'],
  ]) {
    const tsArgs = args.map((a) => (a === '--full' ? '--details' : a)).filter((a) => a !== '--compact');
    const rNative = spawnSync(nativeBin, args, { encoding: 'utf8' });
    const rTs = spawnSync(process.execPath, [tsScript, ...tsArgs], { encoding: 'utf8' });
    assert.equal(rNative.status, 0);
    assert.equal(rNative.stdout, rTs.stdout, `Mismatch for ${args.join(' ')}`);
  }

  const bad = spawnSync(nativeBin, [], { input: '{BAD_JSON', encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, 'Antigrative Dashboard: --\n');
  assert.equal(bad.stderr, '');
});
