# Fusion PDF Renderer

Microservicio Node para generar PDFs visuales de dossiers, propuestas y reportes.

El servicio:

1. Recibe una URL publica de documento.
2. La abre en Chromium headless con viewport `1920x1080`.
3. Captura cada modulo con `data-pdf-page="true"`.
4. Devuelve un PDF 16:9, una pagina por modulo.

## Render

Configura un Web Service con:

```bash
Build Command:
npm install && npm run render:install
```

```bash
Start Command:
npm start
```

Variables de entorno:

```env
PDF_RENDERER_SECRET=usa-el-mismo-secreto-que-en-hostinger
PORT=3000
PLAYWRIGHT_BROWSERS_PATH=0
PDF_RENDERER_VIEWPORT_WIDTH=1440
PDF_RENDERER_VIEWPORT_HEIGHT=810
```

## Healthcheck

```text
GET /health
```

Respuesta esperada:

```json
{"status":"ok"}
```

## Render PDF

```text
POST /render
Authorization: Bearer PDF_RENDERER_SECRET
Content-Type: application/json
```

Body:

```json
{
  "url": "https://app.fusiongg.com/doc/dossier/slug",
  "title": "Dossier Fusion",
  "deviceScaleFactor": 1
}
```

Respuesta: `application/pdf`.

## Hostinger

En `public_html/app/api/.env`:

```env
PDF_RENDERER_APP_URL=https://app.fusiongg.com
PDF_RENDERER_SERVICE_URL=https://tu-servicio-render.onrender.com
PDF_RENDERER_SECRET=usa-el-mismo-secreto-que-en-render
PDF_RENDERER_TIMEOUT=120
PDF_RENDERER_DEVICE_SCALE_FACTOR=1
```

Si el hosting va justo de recursos, deja `1440x810`. Si responde bien, puedes subir
a `1920x1080`.
