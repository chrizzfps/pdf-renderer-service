import { spawnSync } from "node:child_process"
import process from "node:process"

const result = spawnSync(
  process.execPath,
  ["./node_modules/playwright/cli.js", "install", "--with-deps", "chromium"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: "0",
    },
  },
)

process.exit(result.status ?? 1)
