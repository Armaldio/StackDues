export default defineNuxtConfig({
  compatibilityDate: '2026-10-08',
  ssr: false,
  devtools: { enabled: false },
  css: ['~/../src/style.css'],
  app: { head: {
    title: 'StackDues — subscriptions & infrastructure',
    htmlAttrs: { lang: 'en' },
    meta: [{ name: 'description', content: 'Track subscription commitments, upcoming renewals, and infrastructure spend.' }, { name: 'theme-color', content: '#f6f4ed' }],
    link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  } },
  nitro: { preset: 'cloudflare_module' },
})
