import type { QuotaAvailability, QuotaConfidence, QuotaObservation, QuotaSource, ProviderId } from '@shared/types'

/**
 * A provider-specific quota adapter. V1 relies on manual marking plus a signal
 * classifier; V2 will plug real official/cli interfaces here. The contract is
 * deliberately narrow: an adapter turns a provider-specific raw signal (exit
 * code, CLI stderr, a machine-readable field) into a `QuotaObservation`, or
 * returns null when the signal is not quota-related at all.
 */
export interface QuotaAdapter {
  provider: ProviderId
  /**
   * Classify a raw signal. Returns null when this adapter does not recognize
   * the signal as quota information (e.g. a plain network error must not be
   * mislabeled as "quota exhausted").
   */
  observe(raw: { code?: string; message?: string; stderr?: string }): QuotaObservation | null
}

/**
 * Distinguish quota exhaustion from transient errors. A bare `429` is NOT
 * sufficient evidence of exhaustion — it can be a rate limit, a concurrency
 * limit, or a transient upstream throttle. V1 therefore returns `degraded`
 * (unknown confidence) for bare 429s and only reports `blocked` when the
 * signal is explicit.
 */
export function classifyQuotaSignal(raw: { code?: string; message?: string; stderr?: string }): QuotaObservation | null {
  const text = [raw.code, raw.message, raw.stderr].filter(Boolean).join('\n').toLowerCase()

  if (!text) return null

  const explicitBlock = /(quota|rate[-_ ]?limit|usage limit|billing|balance|insufficient credits|credit|budget)/.test(text)
  const exhausted = /(exhausted|exceeded|reached|depleted|out of|no remaining|limit reached|reset)/.test(text)
  const notFound = /(not found|network|econnrefused|etimedout|econnreset|enotfound|socket|dns|timeout|tls|unreachable)/.test(text)

  // Network / lookup failures are not quota events.
  if (notFound && !explicitBlock) return null

  if (explicitBlock && exhausted) {
    return {
      poolId: '',
      availability: 'blocked',
      source: 'cli_signal',
      confidence: 'medium',
      rawCode: raw.code,
      observedAt: new Date().toISOString()
    }
  }

  if (explicitBlock) {
    return {
      poolId: '',
      availability: 'degraded',
      source: 'cli_signal',
      confidence: 'low',
      rawCode: raw.code,
      observedAt: new Date().toISOString()
    }
  }

  return null
}

function manualAdapter(provider: ProviderId): QuotaAdapter {
  return {
    provider,
    observe(raw) {
      return classifyQuotaSignal(raw)
    }
  }
}

export const CodexQuotaAdapter: QuotaAdapter = manualAdapter('codex')
export const DshQuotaAdapter: QuotaAdapter = manualAdapter('dsh')
export const GlmQuotaAdapter: QuotaAdapter = manualAdapter('opencode')

/** Adapters keyed by provider id. DSH/GLM share the same honest classifier. */
export const QUOTA_ADAPTERS: Record<ProviderId, QuotaAdapter> = {
  claude: manualAdapter('claude'),
  codex: CodexQuotaAdapter,
  opencode: GlmQuotaAdapter,
  dsh: DshQuotaAdapter
}

export function getQuotaAdapter(provider: ProviderId): QuotaAdapter {
  return QUOTA_ADAPTERS[provider]
}

export type { QuotaAvailability, QuotaConfidence, QuotaSource }
