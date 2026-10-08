type ScheduledSync = () => Promise<unknown>

/** Keep scheduled providers independent and report persistence/runtime failures without logging secrets. */
export async function runScheduledSyncs(
  costs: ScheduledSync,
  hostinger: ScheduledSync,
  report: (message: string) => void = message => console.error(message),
): Promise<void> {
  const results = await Promise.allSettled([costs(), hostinger()])
  if (results[0]?.status === 'rejected') report('Scheduled AWS and Cloudflare cost sync failed.')
  if (results[1]?.status === 'rejected') report('Scheduled Hostinger renewal sync failed.')
}
