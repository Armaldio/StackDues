export type HostingerCoverageRow = Readonly<{
  status: string; recurrenceInterval: number | null; recurrenceUnit: string | null; isAutoRenewed: boolean
  linkedSubscriptionId: string | null; seenInLatestSync: boolean; automaticallyLinked: boolean; excluded: boolean
  possibleMatches: readonly { id: string; name: string }[]; providerNameCollision: boolean; renewalAvailable: boolean
}>
export type HostingerCoverageDiscovery = Readonly<{
  subscriptions: readonly HostingerCoverageRow[]
  sync: Readonly<{ status: string; lastAttemptAt?: string; lastSyncedAt?: string }>
}>

/** Presentation only: never changes saved commitments or provider renewal eligibility. */
export function hostingerFreshness(sync: HostingerCoverageDiscovery['sync'] | undefined, now = new Date()) {
  if (sync?.status === 'error') return 'failed'
  if (!sync || sync.status === 'not-configured' || !sync.lastSyncedAt || !Number.isFinite(Date.parse(sync.lastSyncedAt))) return 'missing'
  return now.getTime() - Date.parse(sync.lastSyncedAt) > 36 * 60 * 60 * 1000 ? 'stale' : 'current'
}

export function hostingerRowStatus(item: HostingerCoverageRow, sync: HostingerCoverageDiscovery['sync'], now = new Date()): string {
  if (item.excluded) return 'Excluded by you'
  if (sync.status === 'error') return 'Unconfirmed · last sync failed'
  if (!item.seenInLatestSync) return 'Missing from latest successful sync'
  if (hostingerFreshness(sync, now) === 'stale') return 'Stale · refresh to confirm renewal'
  if (!item.isAutoRenewed || !['active', 'in_trial', 'paused'].includes(item.status)) return 'Not renewing'
  if (!item.recurrenceInterval || !item.recurrenceUnit || item.recurrenceUnit === 'unsupported') return 'Unsupported billing period'
  if (!item.renewalAvailable) return 'Unconfirmed · price or date not reported'
  if (item.linkedSubscriptionId) return item.automaticallyLinked ? 'Tracked automatically' : 'Linked to manual subscription'
  if (item.possibleMatches.length || item.providerNameCollision) return 'Unconfirmed · needs review'
  return 'Available to track'
}

/** Explain known coverage gaps without asserting amounts or dates for unknown charges. */
export function hostingerCoverage(discovery: HostingerCoverageDiscovery | undefined, configured: boolean, now = new Date()): string {
  const rows = discovery?.subscriptions ?? []
  if (!configured && !rows.length) return ''
  const freshness = hostingerFreshness(discovery?.sync, now)
  const messages: string[] = []
  if (freshness === 'failed') messages.push('Hostinger sync failed. Saved fixed commitments remain in monthly averages; linked Hostinger renewals cannot be confirmed and are omitted from upcoming charges.')
  else if (freshness === 'missing') messages.push('Hostinger renewal coverage is unavailable: no successful sync could be confirmed. Saved fixed commitments remain recorded; possible renewals may be missing from upcoming charges.')
  else if (freshness === 'stale') messages.push('Hostinger data is stale (over 36 hours old). Saved fixed commitments remain recorded; displayed renewal dates and amounts are last known values, not newly confirmed charges.')
  const missing = rows.filter(item => !item.excluded && !item.seenInLatestSync).length
  if (missing && freshness !== 'failed') messages.push(`${missing} Hostinger service${missing === 1 ? ' is' : 's are'} missing from the latest successful sync; linked Hostinger renewals are omitted from upcoming charges.`)
  const review = rows.filter(item => !item.excluded && !item.linkedSubscriptionId && item.renewalAvailable && (item.possibleMatches.length || item.providerNameCollision)).length
  if (review) messages.push(`${review} possible renewal${review === 1 ? ' needs' : 's need'} review for a manual match or shared provider name; no extra commitment is added.`)
  const untracked = rows.filter(item => !item.excluded && !item.linkedSubscriptionId && item.renewalAvailable && !item.possibleMatches.length && !item.providerNameCollision).length
  if (untracked) messages.push(`${untracked} eligible renewal${untracked === 1 ? ' is' : 's are'} not tracked yet.`)
  const excluded = rows.filter(item => item.excluded).length
  if (excluded) messages.push(`${excluded} service${excluded === 1 ? ' is' : 's are'} excluded by you from automatic commitments.`)
  const nonrenewing = rows.filter(item => !item.excluded && (!item.isAutoRenewed || !['active', 'in_trial', 'paused'].includes(item.status))).length
  if (nonrenewing) messages.push(`${nonrenewing} service${nonrenewing === 1 ? ' is' : 's are'} not renewing; no future recurring charge is assumed.`)
  const unsupported = rows.filter(item => !item.excluded && item.isAutoRenewed && ['active', 'in_trial', 'paused'].includes(item.status) && (!item.recurrenceInterval || !item.recurrenceUnit || item.recurrenceUnit === 'unsupported')).length
  if (unsupported) messages.push(`${unsupported} service${unsupported === 1 ? ' has an' : 's have'} unsupported billing period; no renewal is scheduled from that report.`)
  const incomplete = rows.filter(item => !item.excluded && item.isAutoRenewed && ['active', 'in_trial', 'paused'].includes(item.status) && item.recurrenceInterval && item.recurrenceUnit && item.recurrenceUnit !== 'unsupported' && !item.renewalAvailable).length
  if (incomplete) messages.push(`${incomplete} service${incomplete === 1 ? ' is' : 's are'} unconfirmed because the renewal price or date was not reported; no charge is assumed.`)
  return messages.length ? `Partial Hostinger renewal coverage. ${messages.join(' ')} Review Hostinger services or refresh in Connections before relying on the schedule.` : ''
}
