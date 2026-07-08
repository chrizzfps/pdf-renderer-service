import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const result = spawnSync(
  process.execPath,
  ["./node_modules/playwright/cli.js", "install", "chromium"],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: "0",
    },
  },
)

const makeChromiumExecutablesRunnable = (directory) => {
  if (!fs.existsSync(directory)) return

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      makeChromiumExecutablesRunnable(fullPath)
      continue
    }

    if (entry.name === "chrome-headless-shell" || entry.name === "chrome" || entry.name.endsWith(".sh")) {
      fs.chmodSync(fullPath, 0o755)
    }
  }
}

makeChromiumExecutablesRunnable(path.join(process.cwd(), "node_modules", "playwright-core", ".local-browsers"))

process.exit(result.status ?? 1)
