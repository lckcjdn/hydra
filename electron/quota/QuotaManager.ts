import { randomUUID } from 'crypto'
import type {
  ProviderId,
  QuotaAvailability,
  QuotaConfidence,
  QuotaPool,
  QuotaSource
} from '@shared/types'
import type { OrchestrationStore } from '../orchestration/OrchestrationStore'
import type { EventJournal } from '../orchestration/EventJournal'
import { getQuotaAdapter } from './adapters'

export interface MarkQuotaInput {
  poolId: string
  availability: QuotaAvailability
  resetAt?: string | null
  source?: QuotaSource
  confidence?: QuotaConfidence
}

export interface ObserveQuotaInput {
  provider: ProviderId
  accountAlias: string
  code?: string
  message?: string
  stderr?: string
}

/**
 * Quota pools are scoped to an account/subscription scope — never to a single
 * Session. A pool that is `blocked` freezes new task dispatch on every session
 * that references it, without deleting those sessions.
 */
export class QuotaManager {
  constructor(
    private readonly store: OrchestrationStore,
    private readonly journal: EventJournal
  ) {}

  list(): QuotaPool[] {
    return this.store.getQuotaPools()
  }

  get(poolId: string): QuotaPool | null {
    return this.store.getQuotaPools().find((p) => p.id === poolId) ?? null
  }

  ensurePool(provider: ProviderId, accountAlias: string): QuotaPool {
    const existing = this.store
      .getQuotaPools()
      .find((p) => p.provider === provider && p.accountAlias === accountAlias)
    if (existing) return existing

    const pool: QuotaPool = {
      id: randomUUID(),
      provider,
      accountAlias,
      availability: 'unknown',
      resetAt: null,
      observedAt: null,
      source: 'unknown',
      confidence: 'low'
    }
    this.store.update({ quotaPools: [...this.store.getQuotaPools(), pool] })
    return pool
  }

  mark(input: MarkQuotaInput): QuotaPool {
    const pools = this.store.getQuotaPools()
    const idx = pools.findIndex((p) => p.id === input.poolId)
    if (idx < 0) throw new Error(`Quota pool not found: ${input.poolId}`)

    const previous = pools[idx]
    const next: QuotaPool = {
      ...previous,
      availability: input.availability,
      resetAt: input.resetAt === undefined ? previous.resetAt : input.resetAt,
      observedAt: new Date().toISOString(),
      source: input.source ?? 'manual',
      confidence: input.confidence ?? (input.source === 'official' ? 'high' : 'medium')
    }
    pools[idx] = next
    this.store.update({ quotaPools: pools })

    if (next.availability === 'blocked' && previous.availability !== 'blocked') {
      this.journal.append({
        type: 'quota.blocked',
        source: 'quota-manager',
        evidence: `pool ${next.id} (${next.provider}/${next.accountAlias}) blocked`
      })
    } else if (next.availability !== 'blocked' && previous.availability === 'blocked') {
      this.journal.append({
        type: 'quota.recovered',
        source: 'quota-manager',
        evidence: `pool ${next.id} (${next.provider}/${next.accountAlias}) recovered to ${next.availability}`
      })
    }

    return next
  }

  /**
   * Classify a raw provider signal through the provider adapter. Returns null
   * when the signal is not quota-related. Non-null results are applied to the
   * matching pool when one already exists.
   */
  observe(input: ObserveQuotaInput): QuotaPool | null {
    const adapter = getQuotaAdapter(input.provider)
    const observation = adapter.observe({
      code: input.code,
      message: input.message,
      stderr: input.stderr
    })
    if (!observation) return null

    const pools = this.store.getQuotaPools()
    let pool = pools.find((p) => p.provider === input.provider && p.accountAlias === input.accountAlias)
    if (!pool) {
      pool = this.ensurePool(input.provider, input.accountAlias)
    }

    const next: QuotaPool = {
      ...pool,
      availability: observation.availability,
      resetAt: observation.resetAt ?? pool.resetAt,
      observedAt: observation.observedAt,
      source: observation.source,
      confidence: observation.confidence
    }
    this.store.update({
      quotaPools: pools.map((p) => (p.id === pool!.id ? next : p))
    })

    this.journal.append({
      type: 'quota.observed',
      source: 'quota-adapter',
      evidence: `pool ${next.id} → ${next.availability} (${next.source}/${next.confidence})`
    })

    return next
  }

  /** True when a session cannot receive new tasks because its pool is blocked. */
  isBlocked(poolId: string | null): boolean {
    if (!poolId) return false
    return this.get(poolId)?.availability === 'blocked'
  }
}
