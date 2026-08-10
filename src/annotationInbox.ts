import type { Comment, CommentCategory } from './types'
import { RelativePattern, Uri, window, workspace } from 'vscode'
import { getStorage, refreshAllDecorations } from './decorations'
import { refreshTreeView } from './treeView'

interface InboxAnnotation {
  id: string
  filePath: string
  quote: string
  comment: string
  category?: CommentCategory
  startLine?: number
  endLine?: number
}

interface InboxPayload {
  version: 1
  annotations: InboxAnnotation[]
}

const INBOX_GLOB = '.codereview/inbox/*.json'
const VALID_CATEGORIES = new Set<CommentCategory>(['bug', 'question', 'suggestion', 'nitpick', 'note'])

function isInboxPayload(value: unknown): value is InboxPayload {
  if (!value || typeof value !== 'object') {
    return false
  }

  const payload = value as Partial<InboxPayload>
  return payload.version === 1 && Array.isArray(payload.annotations)
}

function isValidAnnotation(annotation: InboxAnnotation): boolean {
  return typeof annotation?.id === 'string'
    && annotation.id.length > 0
    && typeof annotation.filePath === 'string'
    && annotation.filePath.length > 0
    && typeof annotation.quote === 'string'
    && annotation.quote.length > 0
    && typeof annotation.comment === 'string'
    && annotation.comment.length > 0
}

async function locateQuote(filePath: string, quote: string, startLine?: number, endLine?: number): Promise<{ startLine: number, endLine: number } | undefined> {
  const workspaceRoot = workspace.workspaceFolders?.[0]?.uri
  if (!workspaceRoot) {
    return undefined
  }

  try {
    const document = await workspace.openTextDocument(Uri.joinPath(workspaceRoot, filePath))

    if (startLine && endLine) {
      const start = Math.max(0, startLine - 1)
      const end = Math.min(document.lineCount - 1, endLine - 1)
      if (start <= end) {
        const rangeStart = document.lineAt(start).range.start
        const rangeEnd = document.lineAt(end).range.end
        const candidate = document.getText({ start: rangeStart, end: rangeEnd })
        if (candidate.includes(quote)) {
          return { startLine, endLine }
        }
      }
    }

    const offset = document.getText().indexOf(quote)
    if (offset === -1) {
      return undefined
    }

    const start = document.positionAt(offset)
    const end = document.positionAt(offset + quote.length)
    return {
      startLine: start.line + 1,
      endLine: end.line + 1,
    }
  }
  catch {
    return undefined
  }
}

async function importInboxFile(uri: Uri): Promise<void> {
  const storage = getStorage()
  await storage.load()

  let payload: InboxPayload
  try {
    const bytes = await workspace.fs.readFile(uri)
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!isInboxPayload(parsed)) {
      throw new Error('Expected { version: 1, annotations: [...] }')
    }
    payload = parsed
  }
  catch (error) {
    window.showWarningMessage(`Could not import annotations from ${uri.path}: ${String(error)}`)
    return
  }

  let imported = 0
  const failures: string[] = []

  for (const annotation of payload.annotations) {
    if (!isValidAnnotation(annotation)) {
      failures.push(annotation?.id || '(missing id)')
      continue
    }

    if (storage.getById(annotation.id)) {
      continue
    }

    const location = await locateQuote(annotation.filePath, annotation.quote, annotation.startLine, annotation.endLine)
    if (!location) {
      failures.push(annotation.id)
      continue
    }

    const now = new Date().toISOString()
    const category = annotation.category && VALID_CATEGORIES.has(annotation.category)
      ? annotation.category
      : 'note'

    const comment: Comment = {
      id: annotation.id,
      filePath: annotation.filePath,
      startLine: location.startLine,
      endLine: location.endLine,
      quote: annotation.quote,
      text: annotation.comment,
      category,
      createdAt: now,
      updatedAt: now,
    }

    if (await storage.addImported(comment)) {
      imported++
    }
  }

  if (imported > 0) {
    await refreshAllDecorations()
    refreshTreeView()
  }

  if (failures.length === 0) {
    await workspace.fs.delete(uri)
    if (imported > 0) {
      window.showInformationMessage(`Imported ${imported} external review annotation${imported === 1 ? '' : 's'}`)
    }
  }
  else {
    window.showWarningMessage(`Imported ${imported} annotations; ${failures.length} could not be anchored: ${failures.join(', ')}`)
  }
}

export async function registerAnnotationInbox(): Promise<{ dispose: () => void }> {
  const workspaceFolder = workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    return { dispose() {} }
  }

  const pattern = new RelativePattern(workspaceFolder, INBOX_GLOB)
  const watcher = workspace.createFileSystemWatcher(pattern)

  watcher.onDidCreate(uri => void importInboxFile(uri))
  watcher.onDidChange(uri => void importInboxFile(uri))

  const existing = await workspace.findFiles(pattern)
  for (const uri of existing) {
    await importInboxFile(uri)
  }

  return watcher
}
