import http from "node:http"
import crypto from "node:crypto"
import process from "node:process"
import fs from "node:fs/promises"
import path from "node:path"
import { renderDocumentPdf } from "./render-core.mjs"

const PORT = Number(process.env.PORT || 3000)
const RENDERER_SECRET = (process.env.PDF_RENDERER_SECRET || "").trim()
const MAX_BODY_BYTES = 1024 * 1024
const JOB_TTL_MS = 15 * 60 * 1000
const JOBS_DIR = path.resolve(process.env.PDF_RENDERER_JOBS_DIR || "./storage/jobs")

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

const createJobId = () => crypto.randomBytes(12).toString("hex")

const ensureJobsDir = async () => {
  await fs.mkdir(JOBS_DIR, { recursive: true })
}

const getJobJsonPath = (jobId) => path.join(JOBS_DIR, `${jobId}.json`)
const getJobPdfPath = (jobId) => path.join(JOBS_DIR, `${jobId}.pdf`)

const isValidJobId = (jobId) => /^[a-f0-9]{24}$/i.test(jobId)

const readJobState = async (jobId) => {
  if (!isValidJobId(jobId)) return null

  try {
    const raw = await fs.readFile(getJobJsonPath(jobId), "utf8")
    return JSON.parse(raw)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

const writeJobState = async (jobId, jobState) => {
  await ensureJobsDir()
  await fs.writeFile(getJobJsonPath(jobId), JSON.stringify(jobState), "utf8")
}

const updateJobState = async (jobId, updates) => {
  const current = await readJobState(jobId)
  if (!current) return null

  const next = { ...current, ...updates }
  await writeJobState(jobId, next)
  return next
}

const cleanupJobs = async () => {
  await ensureJobsDir()
  const now = Date.now()
  const entries = await fs.readdir(JOBS_DIR, { withFileTypes: true })

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return

    const jobId = entry.name.replace(/\.json$/, "")
    const job = await readJobState(jobId)
    if (!job || now - job.createdAt <= JOB_TTL_MS) return

    await Promise.all([
      fs.rm(getJobJsonPath(jobId), { force: true }),
      fs.rm(getJobPdfPath(jobId), { force: true }),
    ])
  }))
}

const recoverStaleRenderingJob = async (jobId, job) => {
  if (!job) return null
  if (job.status !== "rendering") return job

  const isStale = Date.now() - (job.updatedAt || job.createdAt) > 2 * 60 * 1000
  if (!isStale) return job

  return await updateJobState(jobId, {
    status: "failed",
    error: "El proceso del renderer se interrumpio antes de terminar el PDF.",
    completedAt: Date.now(),
    updatedAt: Date.now(),
  })
}

const serializeJob = (jobId, job) => ({
  id: jobId,
  status: job.status,
  error: job.error ?? null,
  filename: job.filename,
  createdAt: job.createdAt,
  completedAt: job.completedAt ?? null,
})

const startRenderJob = async (jobId, renderJob) => {
  const jobState = await updateJobState(jobId, {
    status: "rendering",
    updatedAt: Date.now(),
  })
  if (!jobState) return

  try {
    const pdfBytes = await renderDocumentPdf(renderJob)
    await fs.writeFile(getJobPdfPath(jobId), pdfBytes)
    await updateJobState(jobId, {
      status: "completed",
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    await updateJobState(jobId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
}

const sendPdf = async (response, jobId, job) => {
  let pdfBytes

  try {
    pdfBytes = await fs.readFile(getJobPdfPath(jobId))
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(response, 409, {
        ...serializeJob(jobId, job),
        error: "PDF file not ready",
      })
      return
    }
    throw error
  }

  response.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Length": pdfBytes.length,
    "Content-Disposition": `attachment; filename="${job.filename}"`,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": process.env.PDF_RENDERER_CORS_ORIGIN || "https://app.fusiongg.com",
  })
  response.end(pdfBytes)
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

  const jobStatusMatch = pathname.match(/^\/jobs\/([^/]+)$/)
  if (request.method === "GET" && jobStatusMatch) {
    await cleanupJobs()
    const jobId = jobStatusMatch[1]
    const job = await recoverStaleRenderingJob(jobId, await readJobState(jobId))
    if (!job) {
      sendJson(response, 404, { error: "Job not found" })
      return
    }

    sendJson(response, 200, serializeJob(jobId, job))
    return
  }

  const jobPdfMatch = pathname.match(/^\/jobs\/([^/]+)\/pdf$/)
  if (request.method === "GET" && jobPdfMatch) {
    await cleanupJobs()
    const jobId = jobPdfMatch[1]
    const job = await recoverStaleRenderingJob(jobId, await readJobState(jobId))
    if (!job) {
      sendJson(response, 404, { error: "Job not found" })
      return
    }

    if (job.status !== "completed") {
      sendJson(response, 409, serializeJob(jobId, job))
      return
    }

    await sendPdf(response, jobId, job)
    return
  }

  if ((pathname === "/render" || pathname === "/jobs") && request.method !== "POST") {
    sendJson(response, 405, {
      error: "Method not allowed",
      method: request.method,
      path: pathname,
      hint: "The renderer expects POST /render or POST /jobs.",
    })
    return
  }

  if (pathname !== "/render" && pathname !== "/jobs") {
    sendJson(response, 404, { error: "Not found", method: request.method, path: pathname })
    return
  }

  try {
    const job = await readJsonBody(request)
    if (!isAuthorized(request) && !isSignedJob(job)) {
      sendJson(response, 401, { error: "Unauthorized" })
      return
    }

    if (pathname === "/jobs") {
      await cleanupJobs()
      const jobId = createJobId()
      const filename = `${(job.title || "documento").toString().replace(/[^a-z0-9._-]+/gi, "-") || "documento"}.pdf`
      const jobState = {
        status: "queued",
        filename,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await writeJobState(jobId, jobState)

      setImmediate(() => {
        startRenderJob(jobId, job).catch((error) => {
          console.error(error instanceof Error ? error.stack || error.message : String(error))
        })
      })

      sendJson(response, 202, serializeJob(jobId, jobState))
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
