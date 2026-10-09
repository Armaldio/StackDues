export default {
  scrollBehavior(to: { hash: string }, _from: unknown, savedPosition: { left: number; top: number } | null) {
    if (to.hash) return false
    return savedPosition ?? { left: 0, top: 0 }
  },
}
