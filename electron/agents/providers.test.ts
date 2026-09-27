import { describe, expect, it } from 'vitest'
import { resolveBridgePath, getProvider } from './providers'
import type { AgentState } from '@shared/types'

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 'agent-1',
    name: 'dsh agent',
    projectDir: 'D:\\Projects\\hydra',
    provider: 'dsh',
    model: 'deepseek-official/deepseek-v4-flash',
    yolo: false,
    isManager: false,
    sessionId: null,
    initialPrompt: '',
    createdAt: new Date(0).toISOString(),
    status: 'idle',
    pid: null,
    restartCount: 0,
    startedAt: null,
    lastActivityAt: new Date(0).toISOString(),
    workMode: 'local',
    worktreePath: null,
    worktreeBranch: null,
    ...overrides
  }
}

describe('resolveBridgePath', () => {
  it('leaves a development path untouched', () => {
    expect(resolveBridgePath('D:\\Projects\\hydra\\out\\main')).toBe(
      'D:\\Projects\\hydra\\out\\main\\dshBridge.js'
    )
  })

  it('points a packaged app at the unpacked copy, because plain Node cannot read app.asar', () => {
    const packaged = resolveBridgePath('C:\\app\\resources\\app.asar\\out\\main')
    expect(packaged).toContain('app.asar.unpacked')
    expect(packaged).not.toContain(`app.asar${process.platform === 'win32' ? '\\' : '/'}out`)
    expect(packaged.endsWith('dshBridge.js')).toBe(true)
  })
})

describe('dsh provider', () => {
  it('runs the bridge with a real Node binary instead of Electron', () => {
    const spawnSpec = getProvider('dsh').resolveSpawn!(makeState())

    // Electron's own runtime writes nothing to a ConPTY tile, so the bridge must
    // not depend on ELECTRON_RUN_AS_NODE when Node is available.
    expect(spawnSpec.args[0].endsWith('dshBridge.js')).toBe(true)
    if (spawnSpec.command !== process.execPath) {
      expect(spawnSpec.env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    }
  })

  it('passes resume, model, and yolo flags through to the bridge', () => {
    const spawnSpec = getProvider('dsh').resolveSpawn!(
      makeState({
        sessionId: '01d247fb-b4e2-4de8-9934-7a354a928a9e',
        model: 'deepseek-official/deepseek-v4-pro',
        reasoningEffort: 'high',
        yolo: true
      })
    )

    expect(spawnSpec.args).toEqual(
      expect.arrayContaining([
        '--resume',
        '01d247fb-b4e2-4de8-9934-7a354a928a9e',
        '--model',
        'deepseek-official/deepseek-v4-pro',
        '--reasoning-effort',
        'high',
        '--yolo'
      ])
    )
  })

  it('builds a one-shot headless invocation', () => {
    const spawnSpec = getProvider('dsh').resolveHeadlessSpawn!(
      'deepseek-official/deepseek-v4-flash',
      'summarise the repo',
      '01d247fb-b4e2-4de8-9934-7a354a928a9e',
      'low'
    )

    expect(spawnSpec.args).toEqual(
      expect.arrayContaining([
        '--prompt',
        'summarise the repo',
        '--resume',
        '01d247fb-b4e2-4de8-9934-7a354a928a9e',
        '--reasoning-effort',
        'low'
      ])
    )
  })

  it('takes the whole process tree down on stop, since the CLI hides behind a shim', () => {
    expect(getProvider('dsh').killTreeOnStop).toBe(true)
    expect(getProvider('claude').killTreeOnStop).toBeUndefined()
  })

  it('captures the session id the bridge prints', () => {
    const regex = getProvider('dsh').sessionIdRegex!
    expect('session:   dc8bd874-574e-4269-b4ce-bbde76267b3d'.match(regex)?.[1]).toBe(
      'dc8bd874-574e-4269-b4ce-bbde76267b3d'
    )
  })
})
