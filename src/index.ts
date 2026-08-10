import { defineExtension } from 'reactive-vscode'
import { window, workspace } from 'vscode'
import { registerAnnotationInbox } from './annotationInbox'
import { handleFileRename, registerCommands, updateCurrentFilePath } from './commands'
import { disposeDecorations, refreshAllDecorations, updateDecorations } from './decorations'
import { registerPdfReviewEntry } from './pdfReviewEntry'
import { registerTreeView } from './treeView'

const { activate, deactivate } = defineExtension(() => {
  registerCommands()
  registerTreeView()
  const pdfReviewEntry = registerPdfReviewEntry()

  let annotationInbox: { dispose: () => void } | undefined
  void registerAnnotationInbox().then((watcher) => {
    annotationInbox = watcher
  })

  refreshAllDecorations()
  updateCurrentFilePath()

  window.onDidChangeActiveTextEditor((editor) => {
    updateCurrentFilePath()
    if (editor) {
      updateDecorations(editor)
    }
  })

  workspace.onDidOpenTextDocument(() => {
    const editor = window.activeTextEditor
    if (editor) {
      updateDecorations(editor)
    }
  })

  workspace.onDidChangeTextDocument((event) => {
    const editor = window.activeTextEditor
    if (editor && editor.document === event.document) {
      updateDecorations(editor)
    }
  })

  workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('code-notes')) {
      refreshAllDecorations()
    }
  })

  workspace.onDidRenameFiles((event) => {
    for (const { oldUri, newUri } of event.files) {
      handleFileRename(oldUri, newUri)
    }
  })

  return {
    dispose() {
      annotationInbox?.dispose()
      pdfReviewEntry.dispose()
      disposeDecorations()
    },
  }
})

export { activate, deactivate }
