import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DshSessionCatalog, decodeWorkspaceDirName } from './DshSessionCatalog'

const tempDirs: string[] = []

function makeDshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hydra-dsh-session-catalog-'))
  tempDirs.push(dir)
  return dir
}

interface SessionFixture {
  sessionId: string
  /** Encoded workspace directory name, e.g. `--D-Projects-hydra--`. */
  workspace?: string
  createdAt?: number
  modifiedAt?: Date
  cwd?: string
  firstPrompt?: string
  title?: string
  turns?: number
  /** Writes `rows.subagent.identity`, which marks a child session. */
  child?: boolean
  /** Skip the per-session projection cache to exercise fallbacks. */
  skipProjcache?: boolean
  blank?: boolean
}

function writeSession(dshHome: string, fixture: SessionFixture): string {
  const workspace = fixture.workspace ?? '--D-Projects-hydra--'
  const sessionDir = join(dshHome, 'sessions', workspace, fixture.sessionId)
  mkdirSync(sessionDir, { recursive: true })

  const logPath = join(sessionDir, 'session.v3.jsonl.zstd')
  writeFileSync(logPath, 'zstd-bytes', 'utf-8')
  if (fixture.modifiedAt) {
    utimesSync(logPath, fixture.modifiedAt, fixture.modifiedAt)
  }

  if (!fixture.skipProjcache) {
    const cacheDir = join(dshHome, 'storages', 'session_projcache', 'sessions')
    mkdirSync(cacheDir, { recursive: true })

    const rows: Record<string, unknown> = {
      title: { ver: 1, seq: 10, val: fixture.title ?? '' },
      titleInput: {
        ver: 3,
        seq: 10,
        val: { first: { seq: 1, text: fixture.firstPrompt ?? '' }, count: 1, lastSeq: 1 }
      },
      sessionStats: { ver: 1, seq: 10, val: { turns: fixture.turns ?? 0 } },
      subagent: { ver: 2, seq: 10, val: fixture.child ? { identity: { mode: 'continuable' } } : {} },
      sessionListMetadata: { ver: 1, seq: 10, val: { blank: fixture.blank === true } }
    }

    writeFileSync(
      join(cacheDir, `${fixture.sessionId}.json`),
      JSON.stringify({
        version: 7,
        record: {
          identity: {
            formatVersion: 3,
            createdAt: fixture.createdAt ?? 1_790_000_000_000,
            cwd: fixture.cwd ?? 'D:\\Projects\\hydra',
            isSeeded: false
          },
          rows
        }
      }),
      'utf-8'
    )
  }

  return logPath
}

describe('decodeWorkspaceDirName', () => {
  it('decodes plain and escaped workspace directory names', () => {
    const decoded = decodeWorkspaceDirName('--D-Projects-hydra--')
    if (process.platform === 'win32') {
      expect(decoded).toBe('D:\\Projects\\hydra')
    } else {
      expect(decoded).toBe('D/Projects/hydra')
    }

    // `~0020~0028...` decodes as space, `(`, `2`, `)` — the escape is a `~XXXX`
    // code point with no trailing delimiter.
    const escaped = decodeWorkspaceDirName('--C-Users-me-UltraRad-main~0020~00282~0029--')
    expect(escaped).toContain('UltraRad')
    expect(escaped.endsWith('main (2)')).toBe(true)
  })
})

describe('DshSessionCatalog', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists root sessions from the projection cache and log mtime', () => {
    const dshHome = makeDshHome()
    const modifiedAt = new Date('2026-09-27T10:00:00.000Z')
    const logPath = writeSession(dshHome, {
      sessionId: 'session-01d247fb-b4e2-4de8-9934-7a354a928a9e',
      createdAt: 1_790_487_276_978,
      modifiedAt,
      cwd: 'D:\\Projects\\hydra',
      firstPrompt: '这是一个agent管理工具',
      title: 'Agent manager',
      turns: 3
    })

    const catalog = new DshSessionCatalog(dshHome, 0)
    const sessions = catalog.listSessions()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      sessionId: 'session-01d247fb-b4e2-4de8-9934-7a354a928a9e',
      projectPath: 'D:\\Projects\\hydra',
      firstPrompt: '这是一个agent管理工具',
      messageCount: 3,
      gitBranch: null,
      isSidechain: false,
      sourcePath: logPath
    })
    expect(sessions[0].modifiedAt).toBe(modifiedAt.toISOString())
    expect(sessions[0].createdAt).toBe(new Date(1_790_487_276_978).toISOString())
  })

  it('excludes subagent child sessions because ACP cannot resume them', () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, { sessionId: 'root-session', firstPrompt: 'root' })
    writeSession(dshHome, { sessionId: '7a38ee47-3294-405c-a4f9-91ad8cf2cc1a', child: true, firstPrompt: 'child' })

    const sessions = new DshSessionCatalog(dshHome, 0).listSessions()

    expect(sessions.map((session) => session.sessionId)).toEqual(['root-session'])
  })

  it('falls back to the title, the aggregate cache, and the encoded directory name', () => {
    const dshHome = makeDshHome()
    const withTitleOnly = writeSession(dshHome, {
      sessionId: 'title-only',
      firstPrompt: '',
      title: 'Summarised title',
      cwd: 'D:\\Projects\\demo'
    })
    expect(withTitleOnly).toBeTruthy()

    // No per-session projection cache: cwd must come from the aggregate file.
    writeSession(dshHome, {
      sessionId: 'aggregate-only',
      skipProjcache: true,
      workspace: '--D-Projects-aggregate--'
    })
    mkdirSync(join(dshHome, 'storages'), { recursive: true })
    writeFileSync(
      join(dshHome, 'storages', 'session_projcache.json'),
      JSON.stringify({
        unit: { name: 'session_projcache', version: 3 },
        tables: { sessions: { 'aggregate-only': { identity: { createdAt: 1, cwd: 'D:\\Projects\\aggregate' } } } }
      }),
      'utf-8'
    )

    // Neither cache: decode the directory name.
    writeSession(dshHome, {
      sessionId: 'decoded-only',
      skipProjcache: true,
      workspace: '--D-Projects-decoded--'
    })

    const sessions = new DshSessionCatalog(dshHome, 0).listSessions()

    expect(sessions.find((session) => session.sessionId === 'title-only')?.firstPrompt).toBe('Summarised title')
    expect(sessions.find((session) => session.sessionId === 'aggregate-only')?.projectPath).toBe('D:\\Projects\\aggregate')
    expect(sessions.find((session) => session.sessionId === 'decoded-only')?.projectPath).toContain('decoded')
  })

  it('filters by project prefix, hidden ids, age, and limit', () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, {
      sessionId: 'hydra-recent',
      cwd: 'D:\\Projects\\hydra',
      modifiedAt: new Date(),
      firstPrompt: 'hydra'
    })
    writeSession(dshHome, {
      sessionId: 'other-recent',
      cwd: 'D:\\Projects\\other',
      modifiedAt: new Date(),
      firstPrompt: 'other'
    })
    writeSession(dshHome, {
      sessionId: 'hydra-old',
      cwd: 'D:\\Projects\\hydra',
      modifiedAt: new Date('2020-01-01T00:00:00.000Z'),
      firstPrompt: 'old'
    })

    const catalog = new DshSessionCatalog(dshHome, 0)
    expect(catalog.listSessions({ projectPathPrefix: 'D:\\Projects\\hydra' }).map((s) => s.sessionId)).toEqual([
      'hydra-recent',
      'hydra-old'
    ])
    expect(catalog.listSessions({ hiddenSessionIds: ['hydra-recent'] }).map((s) => s.sessionId)).not.toContain(
      'hydra-recent'
    )
    expect(catalog.listSessions({ maxAgeDays: 7 }).map((s) => s.sessionId).sort()).toEqual([
      'hydra-recent',
      'other-recent'
    ])
    expect(catalog.listSessions({ limit: 1 })).toHaveLength(1)
  })

  it('caches snapshots and refreshes on demand', () => {
    const dshHome = makeDshHome()
    writeSession(dshHome, { sessionId: 'first', firstPrompt: 'one' })

    const catalog = new DshSessionCatalog(dshHome, 60_000)
    expect(catalog.listSessions()).toHaveLength(1)

    writeSession(dshHome, { sessionId: 'second', firstPrompt: 'two' })
    expect(catalog.listSessions()).toHaveLength(1)
    expect(catalog.listSessions({ forceRefresh: true })).toHaveLength(2)

    catalog.invalidateCache()
    expect(catalog.listSessions()).toHaveLength(2)
  })

  it('returns nothing when the DSH home has no sessions directory', () => {
    const dshHome = makeDshHome()
    expect(new DshSessionCatalog(dshHome, 0).listSessions()).toEqual([])
  })
})
