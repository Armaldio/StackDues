import type { SubscriptionOrigin } from './subscriptions.ts'

export function subscriptionOriginLabel(origin?: SubscriptionOrigin): string {
  switch (origin) {
    case 'cloudflare-auto':
    case 'hostinger-auto': return 'Auto-discovered'
    case 'cloudflare-linked': return 'Linked to Cloudflare'
    case 'hostinger-linked': return 'Linked to Hostinger'
    default: return 'Manual'
  }
}
