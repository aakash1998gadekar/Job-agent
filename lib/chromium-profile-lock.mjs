import { existsSync, lstatSync, readlinkSync, unlinkSync } from 'fs';
import { join } from 'path';

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function parsePidFromLock(sessionDir) {
  const lockPath = join(sessionDir, 'SingletonLock');
  if (!existsSync(lockPath)) return null;

  try {
    const stat = lstatSync(lockPath);
    const value = stat.isSymbolicLink() ? readlinkSync(lockPath) : '';
    const match = value.match(/-(\d+)$/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearStaleChromiumProfileLock(sessionDir) {
  const pid = parsePidFromLock(sessionDir);
  if (isProcessAlive(pid)) return false;

  let removed = false;
  for (const fileName of LOCK_FILES) {
    const filePath = join(sessionDir, fileName);
    if (!existsSync(filePath)) continue;
    try {
      unlinkSync(filePath);
      removed = true;
    } catch {}
  }
  return removed;
}