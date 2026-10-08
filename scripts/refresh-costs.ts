import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyCostFeed, parseCostFeed, type CostFeed } from '../src/lib/cost-feed.ts'
import { fetchAwsCosts } from '../server/providers/aws.ts'
import { collectCloudflareCosts } from '../server/providers/cloudflare.ts'
import { refreshCosts } from '../server/sync.ts'

/** A failed history download stops publication instead of replacing saved costs with an empty feed. */
export async function loadPreviousFeed(url: string, request: typeof fetch = fetch): Promise<CostFeed> {
  try {
    const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    if (response.status === 404) return emptyCostFeed()
    if (!response.ok) throw new Error('History unavailable')
    return parseCostFeed(await response.json())
  } catch {
    throw new Error('Previous cost history could not be loaded. Publication stopped to preserve the existing deployment.')
  }
}

export async function writeCostFeed(path: string, state: CostFeed): Promise<void> {
  const validated = parseCostFeed(state)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/** Invoked only by trusted Actions jobs. Provider secrets never become build-time frontend variables. */
export async function runRefresh(env: Partial<NodeJS.ProcessEnv> = process.env, now = new Date()): Promise<CostFeed> {
  // Publishing metered spend on public Pages is an explicit repository-owner decision.
  if (env.PUBLISH_PROVIDER_COSTS !== 'true') return emptyCostFeed()
  const previous = env.PREVIOUS_COST_FEED_URL ? await loadPreviousFeed(env.PREVIOUS_COST_FEED_URL) : emptyCostFeed()
  return refreshCosts(previous, [
    { provider: 'aws', configured: Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY), collect: () => fetchAwsCosts({ now }) },
    { provider: 'cloudflare', configured: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN), collect: () => collectCloudflareCosts({ accountId: env.CLOUDFLARE_ACCOUNT_ID!, apiToken: env.CLOUDFLARE_API_TOKEN!, now }) },
  ], now)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const state = await runRefresh()
    await writeCostFeed('public/data/costs.json', state)
    console.log(`Cost refresh: AWS ${state.providers.aws.status}; Cloudflare ${state.providers.cloudflare.status}.`)
  } catch {
    console.error('Cost refresh could not safely publish data. The previous deployment remains available.')
    process.exitCode = 1
  }
}
