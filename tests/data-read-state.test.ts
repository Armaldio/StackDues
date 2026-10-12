import assert from 'node:assert/strict'
import { test } from 'node:test'
import { failedReadState, readStateHasRetainedData, successfulReadState } from '../src/domain/data-read-state.ts'

test('read state distinguishes pending, confirmed empty, and available results', () => {
  assert.equal(successfulReadState(false), 'empty')
  assert.equal(successfulReadState(true), 'available')
})

test('failed reads distinguish no data, expired access, and retained observations', () => {
  assert.equal(failedReadState(false, false), 'unavailable')
  assert.equal(failedReadState(false, true), 'expired')
  assert.equal(failedReadState(true, false), 'retained')
  assert.equal(failedReadState(true, true), 'retained-expired')
  assert.equal(readStateHasRetainedData('retained-expired'), true)
  assert.equal(readStateHasRetainedData('unavailable'), false)
})
