import { defineConfig } from '@playwright/test'

const external = process.env.PLAYWRIGHT_BASE_URL
const baseURL = external ?? 'http://127.0.0.1:4183/billing/'
export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL, locale: 'en-US', viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  webServer: external ? undefined : {
    command: 'npm run preview -- --host 127.0.0.1 --port 4183 --strictPort',
    url: baseURL, reuseExistingServer: false,
  },
})
