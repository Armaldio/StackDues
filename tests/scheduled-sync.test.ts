import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScheduledSyncs } from '../worker/scheduled-sync.ts'

test('scheduled syncs continue independently and report safe failure names', async () => {
  let hostingerRan = false
  const reports: string[] = []
  await runScheduledSyncs(
    async () => { throw new Error('private credential and SQL detail') },
    async () => { hostingerRan = true },
    message => reports.push(message),
  )
  assert.equal(hostingerRan, true)
  assert.deepEqual(reports, ['Scheduled AWS and Cloudflare cost sync failed.'])
  assert.equal(reports.join(' ').includes('private credential'), false)
})
