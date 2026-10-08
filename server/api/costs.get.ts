import { emptyCostFeed } from '../../src/lib/cost-feed'

// PR 1 exposes no published billing JSON. D1 replaces this empty response in PR 2.
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  return emptyCostFeed()
})
