// Server/Actions only: the SDK resolves AWS credentials from the server environment or role.
import { CostExplorerClient, GetCostAndUsageCommand, GetCostForecastCommand, type GetCostAndUsageCommandOutput, type GetCostForecastCommandOutput } from '@aws-sdk/client-cost-explorer'
import { FetchHttpHandler } from '@smithy/fetch-http-handler'
import { createCostSnapshot, normalizeUsageAmount, type CostBreakdown, type CostSnapshot } from '../../src/domain/usage-costs.ts'

export type AwsCostClient = { send(command: GetCostAndUsageCommand | GetCostForecastCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown> }
export type AwsClientCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export type AwsCostOptions = { client?: AwsCostClient; now?: Date; timeoutMs?: number; includeServiceBreakdown?: boolean }

export class AwsCostError extends Error {
  code: string
  constructor(code: string) {
    super(code === 'timeout' ? 'AWS cost refresh timed out.' : code === 'credentials' ? 'AWS billing access was denied. Check the server credentials and billing permissions.' : 'AWS cost refresh failed. Previous cost data has been preserved.')
    this.name = 'AwsCostError'
    this.code = code
  }
}

function safeError(error: unknown): AwsCostError {
  if (error instanceof AwsCostError) return error
  const name = error !== null && typeof error === 'object' && 'name' in error ? String(error.name) : ''
  return new AwsCostError(['AccessDeniedException', 'UnrecognizedClientException', 'CredentialsProviderError', 'ExpiredTokenException'].includes(name) ? 'credentials' : name === 'AbortError' ? 'timeout' : 'provider')
}

export function createAwsClient(credentials?: AwsClientCredentials): AwsCostClient {
  // Workers requires explicit credentials and Fetch; the Node CLI retains its role/environment chain.
  return new CostExplorerClient({ region: 'us-east-1', maxAttempts: 2, ...(credentials ? { credentials, requestHandler: new FetchHttpHandler() } : {}) })
}

async function request(client: AwsCostClient, command: GetCostAndUsageCommand | GetCostForecastCommand, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.send(command, { abortSignal: controller.signal }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new AwsCostError('timeout')) }, timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type PeriodCosts = { amount: number; currency: string; estimated: boolean; breakdown: CostBreakdown[] }

// API periods use inclusive Start, exclusive End; SERVICE groups and all pages contribute to the same observation.
// https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
async function readPeriod(client: AwsCostClient, start: string, end: string, breakdown: boolean, timeoutMs: number): Promise<PeriodCosts[]> {
  const totals = new Map<string, PeriodCosts>()
  const seenTokens = new Set<string>()
  let token: string | undefined
  for (let page = 0; page < 100; page++) {
    const output = await request(client, new GetCostAndUsageCommand({ TimePeriod: { Start: start, End: end }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'], GroupBy: breakdown ? [{ Type: 'DIMENSION', Key: 'SERVICE' }] : undefined, NextPageToken: token }), timeoutMs) as GetCostAndUsageCommandOutput
    for (const result of output.ResultsByTime ?? []) {
      const metrics = breakdown ? (result.Groups ?? []).map(group => ({ metric: group.Metrics?.UnblendedCost, service: group.Keys?.[0] })) : [{ metric: result.Total?.UnblendedCost, service: undefined }]
      for (const { metric, service } of metrics) {
        if (metric?.Amount === undefined || !metric.Unit) throw new AwsCostError('invalid-response')
        const amount = normalizeUsageAmount(metric.Amount)
        const currency = metric.Unit
        const total = totals.get(currency) ?? { amount: 0, currency, estimated: false, breakdown: [] }
        total.amount = normalizeUsageAmount(total.amount + amount)
        total.estimated ||= result.Estimated === true
        if (breakdown) {
          if (!service) throw new AwsCostError('invalid-response')
          const entry = total.breakdown.find(item => item.service === service)
          if (entry) total.breakdown = total.breakdown.map(item => item === entry ? { ...item, amount: normalizeUsageAmount(item.amount + amount) } : item)
          else total.breakdown.push({ service, amount, currency })
        }
        totals.set(currency, total)
      }
    }
    if (!output.NextPageToken) {
      if (!totals.size) throw new AwsCostError('unavailable')
      return [...totals.values()]
    }
    if (seenTokens.has(output.NextPageToken)) throw new AwsCostError('pagination')
    token = output.NextPageToken
    seenTokens.add(token)
  }
  throw new AwsCostError('pagination')
}

function dateString(date: Date): string { return date.toISOString().slice(0, 10) }

/** Month-to-date actuals end at UTC today; forecasts cover today onward and are added once to actuals. */
export async function fetchAwsCosts(options: AwsCostOptions = {}): Promise<CostSnapshot[]> {
  const now = options.now ?? new Date()
  const capturedAt = now.toISOString()
  const today = dateString(now)
  const monthStart = `${today.slice(0, 7)}-01`
  const nextMonth = dateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)))
  const previousStart = dateString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)))
  const comparableEnd = dateString(new Date(Math.min(Date.parse(`${monthStart}T00:00:00Z`), Date.parse(`${previousStart}T00:00:00Z`) + (now.getUTCDate() - 1) * 86_400_000)))
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new AwsCostError('configuration')
  const client = options.client ?? createAwsClient()
  const snapshots: CostSnapshot[] = []
  const append = (costs: PeriodCosts[], start: string, end: string, period: string) => {
    for (const cost of costs) snapshots.push(createCostSnapshot({ id: `aws:${period}:${start}:${end}:${cost.currency}:${capturedAt}`, provider: 'aws', periodStart: start, periodEnd: end, amount: cost.amount, currency: cost.currency, kind: 'actual', capturedAt, metadata: { period, estimated: cost.estimated, breakdown: cost.breakdown } }))
  }
  try {
    let current: PeriodCosts[] = []
    let comparisonUnavailable = false
    const appendPrevious = async (start: string, end: string, period: string) => {
      try {
        append(await readPeriod(client, start, end, false, timeoutMs), start, end, period)
      } catch (error) {
        // New/enabled accounts may lack historical billing data even when current spend is available.
        if (error !== null && typeof error === 'object' && 'name' in error && error.name === 'DataUnavailableException') comparisonUnavailable = true
        else throw error
      }
    }
    if (monthStart < today) {
      current = await readPeriod(client, monthStart, today, options.includeServiceBreakdown ?? true, timeoutMs)
      append(current, monthStart, today, 'current')
      await appendPrevious(previousStart, comparableEnd, 'previous-comparable')
    }
    await appendPrevious(previousStart, monthStart, 'previous-month')
    if (comparisonUnavailable) {
      for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index]!
        if (snapshot.metadata?.period === 'current') snapshots[index] = createCostSnapshot({ ...snapshot, metadata: { ...snapshot.metadata, comparisonUnavailable: true } })
      }
    }
    try {
      // https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostForecast.html
      const forecast = await request(client, new GetCostForecastCommand({ TimePeriod: { Start: today, End: nextMonth }, Metric: 'UNBLENDED_COST', Granularity: 'MONTHLY' }), timeoutMs) as GetCostForecastCommandOutput
      if (forecast.Total?.Amount === undefined || !forecast.Total.Unit) throw new AwsCostError('invalid-response')
      const currency = forecast.Total.Unit
      if (current.length && !current.some(cost => cost.currency === currency)) throw new AwsCostError('invalid-response')
      const actual = current.find(cost => cost.currency === currency)?.amount ?? 0
      snapshots.push(createCostSnapshot({ id: `aws:forecast:${monthStart}:${currency}:${capturedAt}`, provider: 'aws', periodStart: monthStart, periodEnd: nextMonth, amount: actual + normalizeUsageAmount(forecast.Total.Amount), currency, kind: 'forecast', capturedAt, metadata: { period: 'current', forecastStartsAt: today, includesActual: true } }))
    } catch (error) {
      // Forecast permissions/history can differ from actuals. Retain actual data and expose only a fixed status.
      for (let index = 0; index < snapshots.length; index++) {
        const snapshot = snapshots[index]!
        if (snapshot.metadata?.period === 'current') snapshots[index] = createCostSnapshot({ ...snapshot, metadata: { ...snapshot.metadata, forecastUnavailable: true, forecastErrorCode: safeError(error).code } })
      }
    }
    return snapshots
  } catch (error) {
    throw safeError(error)
  }
}
