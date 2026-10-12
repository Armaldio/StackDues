export type DataReadState = 'pending' | 'available' | 'empty' | 'unavailable' | 'expired' | 'retained' | 'retained-expired'

export function successfulReadState(hasRecords: boolean): DataReadState {
  return hasRecords ? 'available' : 'empty'
}

export function failedReadState(hasSuccessfulRead: boolean, sessionExpired: boolean): DataReadState {
  if (hasSuccessfulRead) return sessionExpired ? 'retained-expired' : 'retained'
  return sessionExpired ? 'expired' : 'unavailable'
}

export function readStateHasRetainedData(state: DataReadState): boolean {
  return state === 'available' || state === 'retained' || state === 'retained-expired'
}
