import { defineConfig } from '@playwright/test'

const external = process.env.PLAYWRIGHT_BASE_URL
const port = process.env.PLAYWRIGHT_PORT ?? '4183'
const baseURL = external ?? `http://127.0.0.1:${port}/`
export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    channel: process.env.CI ? 'chrome' : undefined,
    baseURL, locale: 'en-US', viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: external ? undefined : {
    command: `npm run dev -- --host 127.0.0.1 --port ${port}`,
    url: baseURL, reuseExistingServer: false,
  },
})
