import process from "node:process"
import { PDFDocument } from "pdf-lib"

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || "0"

export const PAGE_WIDTH = 1920
export const PAGE_HEIGHT = 1080

const waitForPageAssets = async (page) => {
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => undefined)
  await page.evaluate(async () => {
    await document.fonts?.ready.catch(() => undefined)
    const images = Array.from(document.images)
    await Promise.all(
      images.map((image) => {
        if (image.complete) return Promise.resolve()
        return new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true })
          image.addEventListener("error", resolve, { once: true })
        })
      }),
    )
  })
}

const addCaptureStyles = async (page) => {
  await page.addStyleTag({
    content: `
      [data-pdf-ignore="true"] {
        display: none !important;
      }

      html,
      body {
        width: ${PAGE_WIDTH}px !important;
        min-width: ${PAGE_WIDTH}px !important;
        scroll-behavior: auto !important;
        scroll-snap-type: none !important;
        overflow-x: hidden !important;
      }

      * {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
    `,
  })
}

const captureSections = async (page) => {
  const selector = [
    '[data-pdf-page="true"]',
    '.snap-start',
    '[style*="scroll-snap-align: start"]',
    '[style*="scrollSnapAlign"]',
  ].join(", ")

  await page.waitForSelector(selector, { state: "attached", timeout: 60000 }).catch(() => undefined)

  const sections = page.locator(selector)
  const count = await sections.count()

  if (count === 0) {
    const diagnostics = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText.slice(0, 500),
      htmlClass: document.documentElement.className,
      bodyClass: document.body.className,
    }))
    throw new Error(`No printable document modules were found. Page diagnostics: ${JSON.stringify(diagnostics)}`)
  }

  const captures = []

  for (let index = 0; index < count; index += 1) {
    const section = sections.nth(index)
    await section.scrollIntoViewIfNeeded({ timeout: 30000 })
    await page.waitForTimeout(700)
    await section.evaluate((element) => {
      element.scrollTop = 0
    })

    captures.push(
      await section.screenshot({
        type: "png",
        animations: "disabled",
        timeout: 60000,
      }),
    )
  }

  return captures
}

const buildPdfBytes = async (captures, title) => {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title || "Documento Fusion")
  pdf.setCreator("Fusion PDF Renderer")
  pdf.setProducer("Playwright + pdf-lib")

  for (const capture of captures) {
    const image = await pdf.embedPng(capture)
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT])
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
    })
  }

  return Buffer.from(await pdf.save())
}

export const renderDocumentPdf = async (job) => {
  if (!job?.url) {
    throw new Error("Missing document URL.")
  }

  const browserOptions = { headless: true }
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    browserOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  }

  const { chromium } = await import("playwright")
  const browser = await chromium.launch(browserOptions)

  try {
    const page = await browser.newPage({
      viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      deviceScaleFactor: Number(job.deviceScaleFactor ?? 1),
      colorScheme: "light",
    })

    page.setDefaultTimeout(60000)

    const consoleMessages = []
    const pageErrors = []

    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push(`${message.type()}: ${message.text()}`)
      }
    })
    page.on("pageerror", (error) => {
      pageErrors.push(error.message)
    })

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await waitForPageAssets(page)
    await addCaptureStyles(page)
    await page.waitForTimeout(500)

    let captures
    try {
      captures = await captureSections(page)
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        bodyText: document.body.innerText.slice(0, 500),
        htmlClass: document.documentElement.className,
        bodyClass: document.body.className,
        rootHtml: document.getElementById("root")?.innerHTML.slice(0, 1000) ?? null,
      }))

      throw new Error(
        `${error instanceof Error ? error.message : String(error)} ` +
          `Console: ${JSON.stringify(consoleMessages.slice(-20))} ` +
          `PageErrors: ${JSON.stringify(pageErrors.slice(-20))} ` +
          `Diagnostics: ${JSON.stringify(diagnostics)}`,
      )
    }

    return await buildPdfBytes(captures, job.title)
  } finally {
    await browser.close()
  }
}
