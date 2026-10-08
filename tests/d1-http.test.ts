import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { H3Event } from 'h3'
import { subscriptionId, subscriptionRevision } from '../server/data/http.ts'
import { LedgerError } from '../server/data/ledger.ts'

test('subscription route IDs decode exactly once, preserving spaces, slashes and literal percent signs', () => {
  const event = { context: { params: { id: 'a%2Fb%20%25%252F' } } } as unknown as H3Event
  assert.equal(subscriptionId(event), 'a/b %%2F')
})
test('DELETE requires one strongly quoted positive safe-integer If-Match revision', () => {
  function event(header?: string): H3Event { return { node: { req: { headers: { 'if-match': header } } } } as unknown as H3Event }
  for (const value of ['"1"', '"23"', '"9007199254740991"']) assert.equal(subscriptionRevision(event(value)), Number(value.slice(1, -1)))
  for (const value of [undefined, '', '1', '"0"', '"01"', '"-1"', '"1.0"', 'W/"1"', '*', '"1", "2"', '"9007199254740992"']) {
    assert.throws(() => subscriptionRevision(event(value)), error => error instanceof LedgerError && error.statusCode === 400)
  }
})
