import type { Disposable } from 'vscode'
import { commands, window, workspace } from 'vscode'
import { importPdfAnnotations } from './pdfAnnotationImport'

export function registerPdfReviewEntry(): Disposable {
  return commands.registerCommand('codeReview.importPdfAnnotations', async () => {
    const action = await window.showQuickPick([
      {
        label: '$(comment-discussion) Open PDF Review Preview',
        description: 'Select PDF text and add Doc Note comments directly',
        value: 'preview' as const,
      },
      {
        label: '$(file-pdf) Import Embedded PDF Annotations',
        description: 'Read highlights/comments already stored in a PDF',
        value: 'import' as const,
      },
    ], {
      title: 'PDF Review',
      placeHolder: 'Choose how to review a PDF',
    })

    if (!action) return
    if (action.value === 'import') {
      await importPdfAnnotations()
      return
    }

    const selected = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { PDF: ['pdf'] },
      title: 'Open PDF in Doc Note Review Preview',
    })
    const uri = selected?.[0]
    if (!uri) return

    if (!workspace.getWorkspaceFolder(uri)) {
      window.showErrorMessage('PDF must be inside the current workspace so Doc Note can keep a stable relative path.')
      return
    }

    await commands.executeCommand('vscode.openWith', uri, 'seal-code.pdfPreview')
  })
}
