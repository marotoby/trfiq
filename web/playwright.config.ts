import { defineConfig } from '@playwright/test'

// Runs against an already running trfiq (compose stack, or `scripts/cargo.sh run`).
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.TRFIQ_URL ?? 'http://127.0.0.1:8080',
    viewport: { width: 1400, height: 850 },
    launchOptions: {
      // Software WebGL2 so the spectrogram renders on CI machines without a GPU.
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    },
  },
})
