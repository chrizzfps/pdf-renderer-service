import http from "node:http"
import crypto from "node:crypto"
import process from "node:process"
import { renderDocumentPdf } from "./render-core.mjs"

const PORT = Number(process.env.PORT || 3000)
const RENDERER_SECRET = (process.env.PDF_RENDERER_SECRET || "").trim()
const MAX_BODY_BYTES = 1024 * 1024

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.PDF_RENDERER_CORS_ORIGIN || "https://app.fusiongg.com",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PDF-Renderer-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  })
  response.end(JSON.stringify(payload))
}

const sendCorsPreflight = (response) => {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": process.env.PDF_RENDERER_CORS_ORIGIN || "https://app.fusiongg.com",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PDF-Renderer-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  })
  response.end()
}

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []

    request.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })

    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"))
      } catch {
        reject(new Error("Invalid JSON body."))
      }
    })

    request.on("error", reject)
  })

const isAuthorized = (request) => {
  if (!RENDERER_SECRET) return true
  const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "").trim()
  const rendererSecret = request.headers["x-pdf-renderer-secret"]?.trim()

  return bearerToken === RENDERER_SECRET || rendererSecret === RENDERER_SECRET
}

const isSignedJob = (job) => {
  if (!RENDERER_SECRET) return true
  if (!job?.signature || !job?.expires) return false
  if (Number(job.expires) < Math.floor(Date.now() / 1000)) return false

  const payload = [
    job.url || "",
    job.title || "",
    String(job.deviceScaleFactor ?? 1),
    String(job.expires),
  ].join("|")
  const expected = crypto.createHmac("sha256", RENDERER_SECRET).update(payload).digest("hex")

  try {
    return crypto.timingSafeEqual(Buffer.from(job.signature), Buffer.from(expected))
  } catch {
    return false
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendCorsPreflight(response)
    return
  }

  const pathname = new URL(request.url || "/", "http://localhost").pathname.replace(/\/+$/, "") || "/"

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { status: "ok" })
    return
  }

  if (pathname === "/render" && request.method !== "POST") {
    sendJson(response, 405, {
      error: "Method not allowed",
      method: request.method,
      path: pathname,
      hint: "The renderer expects POST /render. If this says GET, a proxy probably redirected the request.",
    })
    return
  }

  if (pathname !== "/render") {
    sendJson(response, 404, { error: "Not found", method: request.method, path: pathname })
    return
  }

  try {
    const job = await readJsonBody(request)
    if (!isAuthorized(request) && !isSignedJob(job)) {
      sendJson(response, 401, { error: "Unauthorized" })
      return
    }

    const pdfBytes = await renderDocumentPdf(job)

    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": pdfBytes.length,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": process.env.PDF_RENDERER_CORS_ORIGIN || "https://app.fusiongg.com",
    })
    response.end(pdfBytes)
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    sendJson(response, 500, {
      error: "PDF_RENDER_FAILED",
      details: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(PORT, () => {
  console.log(`Fusion PDF renderer listening on port ${PORT}`)
})
