import type { Comment, PdfAnnotationMetadata } from './types'
import { commands, Uri, window, workspace } from 'vscode'
import { getStorage, refreshAllDecorations } from './decorations'
import { refreshTreeView } from './treeView'

interface PdfPoint {
  x: number
  y: number
}

interface PdfAnnotationLike {
  id?: string
  subtype?: string
  rect?: number[]
  quadPoints?: unknown
  contents?: string
  contentsObj?: { str?: string }
}

interface PdfTextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

const MARKUP_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut'])
const BOX_TOLERANCE = 2

function normalizeRect(rect: unknown): number[] | undefined {
  if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every(value => typeof value === 'number')) {
    return undefined
  }
  return rect.slice(0, 4) as number[]
}

function normalizeQuadPoints(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined
  }

  if (value.every(item => typeof item === 'number')) {
    return (value as number[]).slice()
  }

  const flattened: number[] = []
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child)
      }
      return
    }

    if (item && typeof item === 'object') {
      const point = item as Partial<PdfPoint>
      if (typeof point.x === 'number' && typeof point.y === 'number') {
        flattened.push(point.x, point.y)
      }
    }
  }

  visit(value)
  return flattened.length >= 8 ? flattened : undefined
}

function boxesFromGeometry(rect?: number[], quadPoints?: number[]): Box[] {
  const boxes: Box[] = []

  if (quadPoints && quadPoints.length >= 8) {
    for (let i = 0; i + 7 < quadPoints.length; i += 8) {
      const xs = [quadPoints[i], quadPoints[i + 2], quadPoints[i + 4], quadPoints[i + 6]]
      const ys = [quadPoints[i + 1], quadPoints[i + 3], quadPoints[i + 5], quadPoints[i + 7]]
      boxes.push({
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      })
    }
  }

  if (boxes.length === 0 && rect && rect.length >= 4) {
    boxes.push({
      minX: Math.min(rect[0], rect[2]),
      minY: Math.min(rect[1], rect[3]),
      maxX: Math.max(rect[0], rect[2]),
      maxY: Math.max(rect[1], rect[3]),
    })
  }

  return boxes
}

function textItemCenter(item: PdfTextItemLike): PdfPoint | undefined {
  const transform = item.transform
  if (!Array.isArray(transform) || transform.length < 6) {
    return undefined
  }

  const x = transform[4]
  const y = transform[5]
  if (typeof x !== 'number' || typeof y !== 'number') {
    return undefined
  }

  const width = typeof item.width === 'number' ? item.width : 0
  const height = typeof item.height === 'number'
    ? item.height
    : Math.max(Math.abs(transform[0] || 0), Math.abs(transform[3] || 0))

  return {
    x: x + width / 2,
    y: y + height / 2,
  }
}

function pointInsideBox(point: PdfPoint, box: Box): boolean {
  return point.x >= box.minX - BOX_TOLERANCE
    && point.x <= box.maxX + BOX_TOLERANCE
    && point.y >= box.minY - BOX_TOLERANCE
    && point.y <= box.maxY + BOX_TOLERANCE
}

function extractQuote(items: PdfTextItemLike[], rect?: number[], quadPoints?: number[]): string {
  const boxes = boxesFromGeometry(rect, quadPoints)
  if (boxes.length === 0) {
    return ''
  }

  const selected: string[] = []
  for (const item of items) {
    if (!item.str) {
      continue
    }

    const center = textItemCenter(item)
    if (!center || !boxes.some(box => pointInsideBox(center, box))) {
      continue
    }

    selected.push(item.str)
    if (item.hasEOL) {
      selected.push('\n')
    }
  }

  return selected
    .join(' ')
    .replace(/[ \t]+\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function annotationComment(annotation: PdfAnnotationLike): string {
  return annotation.contentsObj?.str?.trim()
    || annotation.contents?.trim()
    || ''
}

function stableAnnotationId(filePath: string, page: number, annotation: PdfAnnotationLike, index: number): string {
  const nativeId = annotation.id || `${annotation.subtype || 'annotation'}-${index}`
  return `pdf:${filePath}:${page}:${nativeId}`
}

export async function importPdfAnnotations(uri?: Uri): Promise<void> {
  let pdfUri = uri
  if (!pdfUri) {
    const selected = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { PDF: ['pdf'] },
      title: 'Import PDF annotations into review comments',
    })
    pdfUri = selected?.[0]
  }

  if (!pdfUri) {
    return
  }

  const workspaceFolder = workspace.getWorkspaceFolder(pdfUri)
  if (!workspaceFolder) {
    window.showErrorMessage('PDF must be inside the current workspace so Doc Note can keep a stable relative path.')
    return
  }

  const filePath = workspace.asRelativePath(pdfUri)
  const bytes = await workspace.fs.readFile(pdfUri)

  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  }
  catch (error) {
    window.showErrorMessage(`Could not load PDF.js: ${String(error)}`)
    return
  }

  const loadingTask = pdfjs.getDocument({ data: bytes })
  const pdf = await loadingTask.promise
  const storage = getStorage()
  await storage.load()

  let imported = 0
  let skippedWithoutComment = 0
  let skippedWithoutQuote = 0

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations({ intent: 'any' }),
        page.getTextContent(),
      ])
      const textItems = textContent.items as PdfTextItemLike[]

      for (let index = 0; index < annotations.length; index++) {
        const annotation = annotations[index] as PdfAnnotationLike
        if (!annotation.subtype || !MARKUP_SUBTYPES.has(annotation.subtype)) {
          continue
        }

        const commentText = annotationComment(annotation)
        if (!commentText) {
          skippedWithoutComment++
          continue
        }

        const rect = normalizeRect(annotation.rect)
        const quadPoints = normalizeQuadPoints(annotation.quadPoints)
        const quote = extractQuote(textItems, rect, quadPoints)
        if (!quote) {
          skippedWithoutQuote++
          continue
        }

        const pdfMetadata: PdfAnnotationMetadata = {
          page: pageNumber,
          ...(rect ? { rect } : {}),
          ...(quadPoints ? { quadPoints } : {}),
        }
        const now = new Date().toISOString()
        const comment: Comment = {
          id: stableAnnotationId(filePath, pageNumber, annotation, index),
          filePath,
          startLine: pageNumber,
          endLine: pageNumber,
          quote,
          text: commentText,
          category: 'note',
          pdf: pdfMetadata,
          createdAt: now,
          updatedAt: now,
        }

        if (await storage.addImported(comment)) {
          imported++
        }
      }
    }
  }
  finally {
    await loadingTask.destroy()
  }

  if (imported > 0) {
    await refreshAllDecorations()
    refreshTreeView()
  }

  const skipped = skippedWithoutComment + skippedWithoutQuote
  const detail = skipped > 0
    ? ` (${skippedWithoutComment} without comments, ${skippedWithoutQuote} without recoverable quotes skipped)`
    : ''
  window.showInformationMessage(`Imported ${imported} PDF annotation${imported === 1 ? '' : 's'}${detail}`)
}

export function registerPdfAnnotationImport(): { dispose: () => void } {
  return commands.registerCommand('codeReview.importPdfAnnotations', importPdfAnnotations)
}
