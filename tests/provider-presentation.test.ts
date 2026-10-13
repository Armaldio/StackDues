import test from 'node:test'
import assert from 'node:assert/strict'
import { currencyUsageNote, missingForecastLabel, providerStatusPresentation } from '../src/domain/provider-presentation.ts'

test('manual-only currency stays neutral when connected providers report another currency', () => {
  assert.equal(currencyUsageNote('EUR', [{ provider: 'aws', configured: true, syncStatus: 'synced', hasSuccessfulSync: true, stale: false, observedCurrencies: ['USD'] }], { feed: 'empty', connections: 'available' }), 'No connected provider reports EUR usage.')
})

test('saved credentials without a successful report remain awaiting first report', () => {
  const status = providerStatusPresentation({ configured: true, syncStatus: 'not-configured', hasObservation: false, stale: false, readState: 'empty' })
  assert.equal(status.state, 'awaiting-first-report')
  assert.match(status.label, /awaiting first report/)
})

test('successful empty check and actual zero are presented distinctly', () => {
  assert.equal(providerStatusPresentation({ configured: true, syncStatus: 'synced', hasObservation: false, stale: false, readState: 'empty' }).state, 'checked-empty')
  assert.equal(providerStatusPresentation({ configured: true, syncStatus: 'synced', hasObservation: true, stale: false, readState: 'available' }).state, 'updated')
})

test('provider-read failure does not claim that saved credentials are disconnected', () => {
  const status = providerStatusPresentation({ configured: true, syncStatus: 'not-configured', hasObservation: false, stale: false, readState: 'unavailable' })
  assert.equal(status.state, 'unavailable')
})

test('pending connection status with an empty feed remains checking', () => {
  const status = providerStatusPresentation({ configured: undefined, syncStatus: 'not-configured', hasObservation: false, stale: false, readState: 'pending' })
  assert.equal(status.state, 'checking')
  assert.doesNotMatch(status.label, /Not connected/)
})

test('unsupported provider forecasts use quiet capability wording', () => {
  assert.equal(missingForecastLabel('aws'), 'Not reported')
  assert.equal(missingForecastLabel('cloudflare'), 'Not provided by this provider')
})
