import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync, readJsonSyncSafe } from '../shared/atomic-fs.ts';

/**
 * Checks whether `targetPath` itself is a symbolic link or Windows junction/reparse point.
 * Compares the target's realpath against `join(realpath(parent), basename)` so ancestor
 * symlinks outside the target (such as macOS `/var -> /private/var`) do not trigger false positives.
 */
export function isReparseOrSymlink(targetPath: string): boolean {
  const absPath = resolve(targetPath);
  let lstat;
  try {
    lstat = lstatSync(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    return code !== 'ENOENT';
  }
  if (lstat.isSymbolicLink()) return true;
  try {
    const resolved = realpathSync(absPath);
    const parentResolved = realpathSync(dirname(absPath));
    return resolved !== join(parentResolved, basename(absPath));
  } catch {
    return true;
  }
}

/**
 * Asserts that `root` and none of its existing descendants are symlinks or junctions.
 */
export function assertRegularTree(root: string): void {
  if (isReparseOrSymlink(root)) {
    throw new Error('Installation path must not be a symlink or junction.');
  }
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (isReparseOrSymlink(child)) {
        throw new Error('Installation paths must not contain symlinks or junctions.');
      }
      if (entry.isDirectory()) stack.push(child);
    }
  }
}

/**
 * Reads a JSON object file synchronously, returning `fallback` when absent.
 */
export function readJsonObjectSync<T extends object = Record<string, unknown>>(
  filePath: string,
  fallback: T = {} as T,
): T {
  if (!existsSync(filePath)) return fallback;
  const parsed = readJsonSyncSafe<unknown>(filePath, { rethrowIo: true, rethrowParse: true });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Configuration at ${filePath} must be a JSON object.`);
  }
  return parsed as T;
}

/**
 * Writes a JSON value atomically with 2-space indentation and trailing newline.
 */
export function writeJsonObjectSync(filePath: string, value: unknown, mode = 0o644): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode,
    flag: 'w',
    fsync: true,
  });
}

function isBusyCopyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EBUSY' || code === 'EPERM';
}

export interface LockedReplaceOps {
  platform?: string;
  tempDir?: string;
  copyFile?: (src: string, dst: string) => void;
  rename?: (oldPath: string, newPath: string) => void;
}

export function displaceLockedFileSync(
  dst: string,
  {
    tempDir = tmpdir(),
    rename = renameSync,
  }: Pick<LockedReplaceOps, 'tempDir' | 'rename'> = {},
): string {
  const stamp = `${process.pid}-${Date.now()}`;
  const tmpTarget = join(tempDir, `ag-pulse-locked-${stamp}-${basename(dst)}`);
  try {
    rename(dst, tmpTarget);
    return tmpTarget;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
    if (code !== 'EXDEV') throw error;
  }
  const fallbackTarget = `${dst}.old.${stamp}`;
  rename(dst, fallbackTarget);
  return fallbackTarget;
}

export function copyFileWithLockedNodeFallbackSync(
  src: string,
  dst: string,
  ops: LockedReplaceOps = {},
): void {
  const platform = ops.platform ?? process.platform;
  const copyFile = ops.copyFile ?? copyFileSync;
  try {
    copyFile(src, dst);
  } catch (error) {
    if (platform === 'win32' && dst.toLowerCase().endsWith('.node') && isBusyCopyError(error)) {
      displaceLockedFileSync(dst, ops);
      copyFile(src, dst);
      return;
    }
    throw error;
  }
}

function copyFileIfChangedSync(src: string, dst: string): void {
  if (existsSync(dst)) {
    try {
      const srcStat = statSync(src);
      const dstStat = statSync(dst);
      if (srcStat.isFile() && dstStat.isFile() && srcStat.size === dstStat.size) {
        if (readFileSync(src).equals(readFileSync(dst))) {
          return;
        }
      }
    } catch {
      // Fall through to normal copy when stat/read check cannot confirm identical contents.
    }
  }
  copyFileWithLockedNodeFallbackSync(src, dst);
}

export interface CopyTreeOptions {
  prune?: boolean;
  shouldPreserve?: (relPath: string, name: string, isDir: boolean) => boolean;
}

const isCaseInsensitivePlatform = process.platform === 'win32' || process.platform === 'darwin';
const entryCompareKey = (name: string): string => (isCaseInsensitivePlatform ? name.toLowerCase() : name);

function lstatSafe(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Recursively copies `source` to `dest`, skipping any matching directory/file predicate.
 * When `options.prune` is enabled, removes stale entries in `dest` that are not copied from
 * `source`, except entries explicitly retained by `options.shouldPreserve`.
 */
export function copyTreeFilteredSync(
  source: string,
  dest: string,
  shouldSkip: (relPath: string, name: string, isDir: boolean) => boolean,
  relPrefix = '',
  options?: CopyTreeOptions,
): void {
  const prune = Boolean(options?.prune);
  const shouldPreserve = options?.shouldPreserve;
  const st = statSync(source);
  if (!st.isDirectory()) {
    if (prune) {
      const dstStat = lstatSafe(dest);
      if (dstStat && (dstStat.isDirectory() || dstStat.isSymbolicLink() || isReparseOrSymlink(dest))) {
        rmSync(dest, { recursive: true, force: true });
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileIfChangedSync(source, dest);
    return;
  }
  if (prune) {
    const dstStat = lstatSafe(dest);
    if (dstStat && (!dstStat.isDirectory() || dstStat.isSymbolicLink() || isReparseOrSymlink(dest))) {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  mkdirSync(dest, { recursive: true });
  const expected = new Map<string, 'dir' | 'file'>();

  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const srcChild = join(source, entry.name);
    const isDir = entry.isDirectory() && !entry.isSymbolicLink() && !isReparseOrSymlink(srcChild);
    if (shouldSkip(rel, entry.name, isDir)) continue;
    const dstChild = join(dest, entry.name);
    if (isDir) {
      expected.set(entryCompareKey(entry.name), 'dir');
      if (prune) {
        const dstStat = lstatSafe(dstChild);
        if (dstStat && (!dstStat.isDirectory() || dstStat.isSymbolicLink() || isReparseOrSymlink(dstChild))) {
          rmSync(dstChild, { recursive: true, force: true });
        }
      }
      copyTreeFilteredSync(srcChild, dstChild, shouldSkip, rel, options);
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      expected.set(entryCompareKey(entry.name), 'file');
      if (prune) {
        const dstStat = lstatSafe(dstChild);
        if (dstStat && (dstStat.isDirectory() || dstStat.isSymbolicLink() || isReparseOrSymlink(dstChild))) {
          rmSync(dstChild, { recursive: true, force: true });
        }
      }
      copyFileIfChangedSync(srcChild, dstChild);
    }
  }

  if (!prune) return;
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const childPath = join(dest, entry.name);
    const isLink = entry.isSymbolicLink() || isReparseOrSymlink(childPath);
    const isDir = !isLink && entry.isDirectory();
    if (shouldPreserve?.(rel, entry.name, isDir)) continue;
    const expectedKind = expected.get(entryCompareKey(entry.name));
    if (isLink || !expectedKind || (expectedKind === 'dir') !== isDir) {
      try {
        rmSync(childPath, { recursive: true, force: true });
      } catch (error) {
        if (!(process.platform === 'win32' && /\.node\.old\./i.test(entry.name) && isBusyCopyError(error))) {
          throw error;
        }
      }
    }
  }
}

/**
 * Resolves an executable on PATH (handling Windows PATHEXT extensions) or returns `null`.
 */
export function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string | null {
  const pathValue = env.PATH || env.Path || '';
  if (name.includes('/') || name.includes('\\')) {
    return existsSync(name) && statSync(name).isFile() ? realpathSync(name) : null;
  }
  const exts =
    platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate =
        platform === 'win32' && !name.toLowerCase().endsWith(ext.toLowerCase())
          ? join(dir, `${name}${ext}`)
          : join(dir, name);
      try {
        const st = statSync(candidate);
        if (st.isFile() && (platform === 'win32' || (st.mode & 0o111) !== 0)) {
          return realpathSync(candidate);
        }
      } catch {
        // Ignore inaccessible PATH entry.
      }
    }
  }
  return null;
}
