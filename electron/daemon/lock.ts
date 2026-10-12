import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export interface DaemonLockData {
  pid: number
  /** TCP port the daemon's HTTP+WS server listens on (127.0.0.1). */
  port: number
  startedAt: string
}

export function readLockFile(lockPath: string): DaemonLockData | null {
  try {
    if (!existsSync(lockPath)) return null
    const raw = readFileSync(lockPath, 'utf-8')
    const data = JSON.parse(raw) as DaemonLockData
    if (!data.pid || typeof data.port !== 'number') return null

    // Check if PID is still alive
    try {
      process.kill(data.pid, 0)
      return data
    } catch {
      // PID is dead — stale lock file
      removeLockFile(lockPath)
      return null
    }
  } catch {
    return null
  }
}

export function writeLockFile(lockPath: string, data: DaemonLockData): void {
  const dir = dirname(lockPath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(lockPath, JSON.stringify(data, null, 2), 'utf-8')
}

export function removeLockFile(lockPath: string): void {
  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  } catch {
    // Best-effort cleanup
  }
}
