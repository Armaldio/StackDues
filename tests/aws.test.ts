import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GetCostAndUsageCommand, GetCostForecastCommand } from '@aws-sdk/client-cost-explorer'
import { AwsCostError, fetchAwsCosts, type AwsCostClient } from '../server/providers/aws.ts'

const now = new Date('2026-10-07T12:00:00Z')
const total = (amount: string) => ({ ResultsByTime: [{ Total: { UnblendedCost: { Amount: amount, Unit: 'USD' } }, Estimated: false }] })
const group = (service: string, amount: string) => ({ Keys: [service], Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } } })

function fake(responses: unknown[]): { client: AwsCostClient; commands: (GetCostAndUsageCommand | GetCostForecastCommand)[] } {
  const commands: (GetCostAndUsageCommand | GetCostForecastCommand)[] = []
  return { commands, client: { async send(command) { commands.push(command); const response = responses.shift(); if (response instanceof Error) throw response; return response } } }
}

test('AWS pages service groups, keeps comparisons separate and adds remaining forecast once', async () => {
  const { client, commands } = fake([
    { ResultsByTime: [{ Groups: [group('S3', '2.5')], Estimated: true }], NextPageToken: 'page2' },
    { ResultsByTime: [{ Groups: [group('EC2', '10')] }] },
    total('9'), total('44'), { Total: { Amount: '20', Unit: 'USD' } },
  ])
  const snapshots = await fetchAwsCosts({ client, now })
  assert.deepEqual(snapshots.map(snapshot => [snapshot.metadata?.period, snapshot.kind, snapshot.amount]), [['current', 'actual', 12.5], ['previous-comparable', 'actual', 9], ['previous-month', 'actual', 44], ['current', 'forecast', 32.5]])
  assert.deepEqual((snapshots[0]?.metadata?.breakdown as { service: string }[]).map(item => item.service), ['S3', 'EC2'])
  assert.equal(snapshots[0]?.metadata?.estimated, true)
  assert.deepEqual(commands[0]?.input.TimePeriod, { Start: '2026-10-01', End: '2026-10-07' })
  assert.equal((commands[1] as GetCostAndUsageCommand).input.NextPageToken, 'page2')
  assert.deepEqual(commands[2]?.input.TimePeriod, { Start: '2026-09-01', End: '2026-09-07' })
  assert.deepEqual(commands[4]?.input.TimePeriod, { Start: '2026-10-07', End: '2026-11-01' })
  assert.equal(snapshots[3]?.periodStart, '2026-10-01')
})

test('forecast unavailable or denied preserves actuals and exposes no provider error text', async () => {
  for (const name of ['DataUnavailableException', 'AccessDeniedException']) {
    const error = Object.assign(new Error('SECRET_KEY must never leave the server'), { name })
    const { client } = fake([total('12'), total('9'), total('40'), error])
    const snapshots = await fetchAwsCosts({ client, now, includeServiceBreakdown: false })
    assert.equal(snapshots.length, 3)
    assert.equal(snapshots[0]?.metadata?.forecastUnavailable, true)
    assert.equal(JSON.stringify(snapshots).includes('SECRET_KEY'), false)
  }
})

test('actual failures return sanitized fixed error messages', async () => {
  const { client } = fake([Object.assign(new Error('AKIA_PRIVATE_SECRET credentials failed'), { name: 'AccessDeniedException' })])
  await assert.rejects(fetchAwsCosts({ client, now }), error => error instanceof AwsCostError && error.code === 'credentials' && !error.message.includes('AKIA_PRIVATE'))
})

test('invalid monetary responses fail rather than becoming zero', async () => {
  for (const amount of ['NaN', '', '1USD']) {
    const { client } = fake([total(amount)])
    await assert.rejects(fetchAwsCosts({ client, now, includeServiceBreakdown: false }), AwsCostError)
  }
})

test('repeated pagination tokens fail safely instead of looping', async () => {
  const page = { ResultsByTime: [{ Groups: [group('S3', '2')] }], NextPageToken: 'same' }
  const { client, commands } = fake([page, page])
  await assert.rejects(fetchAwsCosts({ client, now }), error => error instanceof AwsCostError && error.code === 'pagination')
  assert.equal(commands.length, 2)
})

test('timeout bounds a client that never resolves and sends an abort signal', async () => {
  let signal: AbortSignal | undefined
  const client: AwsCostClient = { send(_command, options) { signal = options?.abortSignal; return new Promise(() => {}) } }
  await assert.rejects(fetchAwsCosts({ client, now, timeoutMs: 5 }), error => error instanceof AwsCostError && error.code === 'timeout')
  assert.equal(signal?.aborted, true)
})

test('first day avoids invalid empty actual ranges and year boundaries remain correct', async () => {
  const { client, commands } = fake([total('31'), { Total: { Amount: '40', Unit: 'USD' } }])
  const snapshots = await fetchAwsCosts({ client, now: new Date('2027-01-01T01:00:00Z') })
  assert.equal(commands.length, 2)
  assert.deepEqual(commands[0]?.input.TimePeriod, { Start: '2026-12-01', End: '2027-01-01' })
  assert.deepEqual(commands[1]?.input.TimePeriod, { Start: '2027-01-01', End: '2027-02-01' })
  assert.equal(snapshots[1]?.amount, 40)
})

test('matched previous comparison clamps to shorter month length', async () => {
  const { client, commands } = fake([total('31'), total('28'), total('28'), { Total: { Amount: '1', Unit: 'USD' } }])
  await fetchAwsCosts({ client, now: new Date('2026-03-31T12:00:00Z'), includeServiceBreakdown: false })
  assert.deepEqual(commands[1]?.input.TimePeriod, { Start: '2026-02-01', End: '2026-03-01' })
})

test('unavailable previous-period history preserves available current actuals and forecasts', async () => {
  const unavailable = Object.assign(new Error('private billing detail'), { name: 'DataUnavailableException' })
  const { client } = fake([total('12'), unavailable, unavailable, { Total: { Amount: '20', Unit: 'USD' } }])
  const snapshots = await fetchAwsCosts({ client, now, includeServiceBreakdown: false })
  assert.deepEqual(snapshots.map(snapshot => [snapshot.kind, snapshot.amount]), [['actual', 12], ['forecast', 32]])
  assert.equal(snapshots[0]?.metadata?.comparisonUnavailable, true)
  assert.equal(snapshots.some(snapshot => snapshot.metadata?.period === 'previous-month'), false)
  assert.equal(JSON.stringify(snapshots).includes('private'), false)
})

test('forecast currency mismatch is unavailable rather than an incomplete whole-month forecast', async () => {
  const { client } = fake([total('12'), total('9'), total('40'), { Total: { Amount: '20', Unit: 'EUR' } }])
  const snapshots = await fetchAwsCosts({ client, now, includeServiceBreakdown: false })
  assert.equal(snapshots.length, 3)
  assert.equal(snapshots.some(snapshot => snapshot.kind === 'forecast'), false)
  assert.equal(snapshots[0]?.metadata?.forecastUnavailable, true)
})
