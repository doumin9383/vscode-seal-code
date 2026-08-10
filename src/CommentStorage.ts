import type { Comment, CommentCategory } from './types'
import { Range, Uri, workspace } from 'vscode'
import { ensureCommentsFile, getCommentsFilePath } from './storage'

type StoredComment = Omit<Comment, 'quote'> & { quote?: string }

export class CommentStorage {
  private comments: Comment[] = []

  async load(): Promise<Comment[]> {
    const filePath = await getCommentsFilePath()
    if (!filePath) {
      return []
    }

    try {
      const content = await workspace.fs.readFile(filePath)
      const storedComments = JSON.parse(new TextDecoder().decode(content)) as StoredComment[]
      let migrated = false

      this.comments = await Promise.all(storedComments.map(async (comment) => {
        if (typeof comment.quote === 'string') {
          return comment as Comment
        }

        migrated = true
        return {
          ...comment,
          quote: await this.recoverLegacyQuote(comment.filePath, comment.startLine, comment.endLine),
        }
      }))

      if (migrated) {
        await this.save()
      }
    }
    catch {
      this.comments = []
    }

    return this.comments
  }

  async save(): Promise<void> {
    const filePath = await ensureCommentsFile()
    if (!filePath) {
      return
    }

    const content = JSON.stringify(this.comments, null, 2)
    await workspace.fs.writeFile(filePath, new TextEncoder().encode(content))
  }

  async add(
    filePath: string,
    startLine: number,
    endLine: number,
    quote: string,
    text: string,
    category: CommentCategory,
  ): Promise<Comment> {
    const now = new Date().toISOString()
    const comment: Comment = {
      id: crypto.randomUUID(),
      filePath,
      startLine,
      endLine,
      quote,
      text,
      category,
      createdAt: now,
      updatedAt: now,
    }

    this.comments.push(comment)
    await this.save()
    return comment
  }

  async update(id: string, updates: Partial<Pick<Comment, 'text' | 'category'>>): Promise<Comment | undefined> {
    const index = this.comments.findIndex(c => c.id === id)
    if (index === -1) {
      return undefined
    }

    this.comments[index] = {
      ...this.comments[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    }

    await this.save()
    return this.comments[index]
  }

  async delete(id: string): Promise<boolean> {
    const index = this.comments.findIndex(c => c.id === id)
    if (index === -1) {
      return false
    }

    this.comments.splice(index, 1)
    await this.save()
    return true
  }

  getAll(): Comment[] {
    return this.comments
  }

  getById(id: string): Comment | undefined {
    return this.comments.find(c => c.id === id)
  }

  getByFilePath(filePath: string): Comment[] {
    return this.comments.filter(c => c.filePath === filePath)
  }

  async clearAll(): Promise<number> {
    const count = this.comments.length
    this.comments = []
    await this.save()
    return count
  }

  async updateFilePaths(oldPath: string, newPath: string): Promise<number> {
    let updated = 0
    for (const comment of this.comments) {
      if (comment.filePath === oldPath) {
        comment.filePath = newPath
        updated++
      }
    }
    if (updated > 0) {
      await this.save()
    }
    return updated
  }

  private async recoverLegacyQuote(filePath: string, startLine: number, endLine: number): Promise<string> {
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri
    if (!workspaceRoot) {
      return ''
    }

    try {
      const document = await workspace.openTextDocument(Uri.joinPath(workspaceRoot, filePath))
      if (document.lineCount === 0) {
        return ''
      }

      const start = Math.max(0, Math.min(startLine - 1, document.lineCount - 1))
      const end = Math.max(start, Math.min(endLine - 1, document.lineCount - 1))
      const endColumn = document.lineAt(end).text.length
      return document.getText(new Range(start, 0, end, endColumn))
    }
    catch {
      return ''
    }
  }
}
