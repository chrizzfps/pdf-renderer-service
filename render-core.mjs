import process from "node:process"
import { chromium } from "playwright"
import { PDFDocument } from "pdf-lib"

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
  const sections = page.locator('[data-pdf-page="true"]')
  const count = await sections.count()

  if (count === 0) {
    throw new Error("No printable document modules were found.")
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

  const browser = await chromium.launch(browserOptions)

  try {
    const page = await browser.newPage({
      viewport: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
      deviceScaleFactor: Number(job.deviceScaleFactor ?? 1),
      colorScheme: "light",
    })

    page.setDefaultTimeout(60000)
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 60000 })
    await waitForPageAssets(page)
    await addCaptureStyles(page)
    await page.waitForTimeout(500)

    const captures = await captureSections(page)
    return await buildPdfBytes(captures, job.title)
  } finally {
    await browser.close()
  }
}
