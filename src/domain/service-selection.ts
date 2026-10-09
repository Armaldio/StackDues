import type { CostProvider } from './usage-costs.ts'

export type ServiceSelection =
  | { kind: 'provider'; provider: CostProvider | 'hostinger' | 'github' }
  | { kind: 'subscription'; id: string }
