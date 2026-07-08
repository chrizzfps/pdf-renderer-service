import http from "node:http"
import process from "node:process"
import { renderDocumentPdf } from "./render-core.mjs"

const PORT = Number(process.env.PORT || 3000)
const RENDERER_SECRET = (process.env.PDF_RENDERER_SECRET || "").trim()
const MAX_BODY_BYTES = 1024 * 1024

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  response.end(JSON.stringify(payload))
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

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" })
    return
  }

  if (request.method !== "POST" || request.url !== "/render") {
    sendJson(response, 404, { error: "Not found" })
    return
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" })
    return
  }

  try {
    const job = await readJsonBody(request)
    const pdfBytes = await renderDocumentPdf(job)

    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": pdfBytes.length,
      "Cache-Control": "no-store",
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
