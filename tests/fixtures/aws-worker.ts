import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { FetchHttpHandler } from '@smithy/fetch-http-handler'
import { createAwsClient, fetchAwsCosts } from '../../server/providers/aws.ts'

// Local workerd fixture only. These credentials are deliberately fake; every SDK
// request is intercepted, and no request can reach AWS or another remote service.
export default {
  async fetch() {
    const nativeFetch = globalThis.fetch
    const requests: { target: string; signed: boolean; endpoint: string }[] = []
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const target = request.headers.get('x-amz-target') ?? ''
      const authorization = request.headers.get('authorization') ?? ''
      const endpoint = new URL(request.url).hostname
      if (endpoint !== 'ce.us-east-1.amazonaws.com' || request.method !== 'POST') throw new Error('Unexpected mock request')
      const body = await request.json() as { GroupBy?: unknown }
      const signed = /^AWS4-HMAC-SHA256 Credential=TESTACCESSKEY\//.test(authorization)
        && authorization.includes('/us-east-1/ce/aws4_request')
        && /Signature=[a-f0-9]{64}/.test(authorization)
        && request.headers.has('x-amz-date')
        && request.headers.get('x-amz-security-token') === 'TESTSESSIONTOKEN'
      requests.push({ target, signed, endpoint })
      if (!target.endsWith('GetCostForecast') && !target.endsWith('GetCostAndUsage')) throw new Error('Unexpected mock operation')
      const response = target.endsWith('GetCostForecast')
        ? { Total: { Amount: '10', Unit: 'USD' } }
        : { ResultsByTime: [{ Estimated: false, Total: { UnblendedCost: { Amount: '9', Unit: 'USD' } }, Groups: body.GroupBy ? [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '9', Unit: 'USD' } } }] : undefined }] }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/x-amz-json-1.1' } })
    }
    try {
      let missingCredentials: string | undefined
      try {
        await createAwsClient().send(new GetCostAndUsageCommand({ TimePeriod: { Start: '2026-10-01', End: '2026-10-08' }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] }))
      } catch (error) { missingCredentials = (error as Error).message }
      const client = new CostExplorerClient({
        region: 'us-east-1',
        maxAttempts: 2,
        credentials: { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'TESTFAKESECRETNOTREAL', sessionToken: 'TESTSESSIONTOKEN' },
        requestHandler: new FetchHttpHandler(),
      })
      const snapshots = await fetchAwsCosts({ client, now: new Date('2026-10-08T12:00:00Z') })
      return Response.json({ missingCredentials, requests, snapshots: snapshots.map(({ provider, amount, currency, kind, metadata }) => ({ provider, amount, currency, kind, period: metadata?.period })) })
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 })
    } finally {
      globalThis.fetch = nativeFetch
    }
  },
}
