import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, webContents } from 'electron'

/**
 * Ports a dev server is likely to be sitting on.
 *
 * The preview panel exists mostly to look at the thing you are building, and
 * the address of that thing is nearly always one of these. Probing beats making
 * someone remember whether this project came up on 5173 or 3000.
 */
const CANDIDATES = [
  3000, 3001, 3333, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8788, 9000
]

/**
 * Servers that answer on a dev port but are not what anyone means by one.
 *
 * macOS runs AirPlay Receiver on 5000 out of the box, and it speaks HTTP, so a
 * plain "is the port open?" check reports it as a dev server on every Mac. A
 * chip that opens Apple's AirPlay endpoint is worse than no chip.
 */
const NOT_A_DEV_SERVER = /^server:\s*(airtunes|airplay)/im

/**
 * True if something on this loopback port answers HTTP like a web server.
 *
 * A TCP handshake alone is not enough: plenty of things listen on these ports
 * without serving pages, and the panel can only usefully open a page.
 */
function isWebServer(port: number, timeout = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    let head = ''

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }

    socket.setTimeout(timeout)
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))

    socket.once('connect', () => {
      socket.write(`HEAD / HTTP/1.0\r\nHost: localhost:${port}\r\n\r\n`)
    })

    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      // The status line and headers are all that matter, and they arrive first.
      if (head.length < 512 && !head.includes('\r\n\r\n')) return
      finish(head.startsWith('HTTP/') && !NOT_A_DEV_SERVER.test(head))
    })

    // Loopback only. This never reaches beyond the machine it runs on.
    socket.connect(port, '127.0.0.1')
  })
}

/** Which of the usual dev-server ports are serving pages right now. */
export async function devPorts(): Promise<number[]> {
  const results = await Promise.all(
    CANDIDATES.map(async (port) => ((await isWebServer(port)) ? port : 0))
  )
  return results.filter((p): p is number => p > 0)
}

export interface CaptureResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * Builds a deterministic, sanitized filename for a captured preview image.
 * No user or renderer input is used in naming.
 */
export function buildCaptureFilename(now = Date.now()): string {
  return `preview-${now.toString(36)}.png`
}

/**
 * Deletes preview capture files older than maxAgeMs (default 24h).
 * Bounded work: examines at most maxExamine files per call.
 */
export async function cleanupOldCaptures(
  dir: string,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
  maxExamine = 200
): Promise<number> {
  let cleaned = 0
  try {
    const files = await fs.promises.readdir(dir)
    const candidates = files.slice(0, maxExamine)
    for (const file of candidates) {
      if (!file.startsWith('preview-') || !file.endsWith('.png')) continue
      const filePath = path.join(dir, file)
      try {
        const stat = await fs.promises.stat(filePath)
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(filePath)
          cleaned += 1
        }
      } catch {
        /* ignore individual stat or unlink error */
      }
    }
  } catch {
    /* dir might not exist yet */
  }
  return cleaned
}

/**
 * Captures a preview webview guest by webContentsId, validating that it belongs
 * to our main window, downscaling to <= 1600px width, and saving to temp dir.
 */
export async function captureWebview(
  webContentsId: number,
  hostWindow: BrowserWindow | null
): Promise<CaptureResult> {
  if (typeof webContentsId !== 'number' || !Number.isInteger(webContentsId) || webContentsId <= 0) {
    return { ok: false, error: 'Invalid webContentsId' }
  }

  if (!hostWindow || hostWindow.isDestroyed()) {
    return { ok: false, error: 'Host window is not available' }
  }

  const targetWc = webContents.fromId(webContentsId)
  if (!targetWc || targetWc.isDestroyed()) {
    return { ok: false, error: 'Webview is not attached or was destroyed' }
  }

  // Validate that the target webContents is a webview guest hosted by our main window
  if (
    targetWc.getType() !== 'webview' ||
    targetWc.hostWebContents?.id !== hostWindow.webContents.id
  ) {
    return { ok: false, error: 'Unauthorized: target is not a webview guest of the host window' }
  }

  try {
    const image = await targetWc.capturePage()
    if (image.isEmpty()) {
      return { ok: false, error: 'Capture resulted in an empty image (panel may be hidden or unpainted)' }
    }

    // Downscale to <= 1600 px wide
    const size = image.getSize()
    let processed = image
    if (size.width > 1600) {
      processed = image.resize({ width: 1600 })
    }

    const pngBuffer = processed.toPNG()
    const capturesDir = path.join(app.getPath('temp'), 'eaon-ade-captures')
    await fs.promises.mkdir(capturesDir, { recursive: true })

    const filename = buildCaptureFilename()
    const filePath = path.join(capturesDir, filename)
    await fs.promises.writeFile(filePath, pngBuffer)

    // Bounded cleanup of files older than 24 hours
    void cleanupOldCaptures(capturesDir).catch(() => undefined)

    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: `Failed to capture page: ${err instanceof Error ? err.message : String(err)}` }
  }
}

