import type { CustomDocument, CustomReadonlyEditorProvider, WebviewPanel } from 'vscode'
import * as path from 'node:path'
import { Uri, window, workspace } from 'vscode'
import { getStorage, refreshAllDecorations } from './decorations'
import { refreshTreeView } from './treeView'

class PdfPreviewDocument implements CustomDocument {
  constructor(public readonly uri: Uri) {}
  dispose(): void {}
}

export class PdfPreviewProvider implements CustomReadonlyEditorProvider<PdfPreviewDocument> {
  openCustomDocument(uri: Uri): PdfPreviewDocument {
    return new PdfPreviewDocument(uri)
  }

  async resolveCustomEditor(document: PdfPreviewDocument, webviewPanel: WebviewPanel): Promise<void> {
    const extensionRoot = Uri.file(path.join(__dirname, '..'))
    const pdfJsRoot = Uri.joinPath(extensionRoot, 'node_modules', 'pdfjs-dist')
    const webview = webviewPanel.webview
    webview.options = {
      enableScripts: true,
      localResourceRoots: [extensionRoot, pdfJsRoot, Uri.joinPath(document.uri, '..')],
    }

    const pdfUri = webview.asWebviewUri(document.uri)
    const pdfJsUri = webview.asWebviewUri(Uri.joinPath(pdfJsRoot, 'build', 'pdf.mjs'))
    const workerUri = webview.asWebviewUri(Uri.joinPath(pdfJsRoot, 'build', 'pdf.worker.mjs'))
    webview.html = this.getHtml(pdfUri.toString(), pdfJsUri.toString(), workerUri.toString())

    webview.onDidReceiveMessage(async (message) => {
      if (message?.type !== 'addComment') return

      const quote = typeof message.quote === 'string' ? message.quote.trim() : ''
      const commentText = typeof message.comment === 'string' ? message.comment.trim() : ''
      const page = Number(message.page)
      const rect = Array.isArray(message.rect) ? message.rect.map(Number).filter(Number.isFinite) : undefined

      if (!quote || !commentText || !Number.isInteger(page) || page < 1) {
        window.showWarningMessage('Could not create PDF review comment: invalid selection')
        return
      }

      const storage = getStorage()
      await storage.load()
      const now = new Date().toISOString()
      await storage.addImported({
        id: crypto.randomUUID(),
        filePath: workspace.asRelativePath(document.uri),
        startLine: page,
        endLine: page,
        quote,
        text: commentText,
        category: 'note',
        pdf: { page, rect },
        createdAt: now,
        updatedAt: now,
      })

      refreshTreeView()
      await refreshAllDecorations()
      void webview.postMessage({ type: 'commentAdded' })
    })
  }

  private getHtml(pdfUri: string, pdfJsUri: string, workerUri: string): string {
    return `<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
#toolbar{position:sticky;top:0;z-index:10;display:flex;gap:10px;align-items:center;padding:8px 12px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
#status{opacity:.8;font-size:12px}.commentBox{display:none;gap:6px;align-items:center;flex:1}.commentBox input{flex:1;min-width:220px}
#viewer{display:flex;flex-direction:column;align-items:center;gap:18px;padding:18px}.page{position:relative;background:white;box-shadow:0 2px 12px rgba(0,0,0,.25)}.page canvas{display:block}
.textLayer{position:absolute;inset:0;overflow:hidden;line-height:1}.textLayer span{color:transparent;position:absolute;white-space:pre;transform-origin:0 0;cursor:text}.textLayer ::selection{background:rgba(0,120,215,.35)}
</style></head><body>
<div id="toolbar"><strong>Doc Note PDF</strong><span id="status">Loading…</span><div id="commentBox" class="commentBox"><input id="commentInput" placeholder="Comment on selected text…"><button id="saveComment">Add</button><button id="cancelComment">Cancel</button></div></div>
<div id="viewer"></div>
<script type="module">
import * as pdfjsLib from '${pdfJsUri}';
pdfjsLib.GlobalWorkerOptions.workerSrc='${workerUri}';
const vscode=acquireVsCodeApi(),viewer=document.getElementById('viewer'),status=document.getElementById('status'),commentBox=document.getElementById('commentBox'),commentInput=document.getElementById('commentInput');let pendingSelection=null;
const pdf=await pdfjsLib.getDocument('${pdfUri}').promise;status.textContent=pdf.numPages+' pages · drag-select text to comment';
for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber++){
 const page=await pdf.getPage(pageNumber),viewport=page.getViewport({scale:1.35}),pageDiv=document.createElement('div');pageDiv.className='page';pageDiv.dataset.page=String(pageNumber);pageDiv.style.width=viewport.width+'px';pageDiv.style.height=viewport.height+'px';
 const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';pageDiv.appendChild(canvas);viewer.appendChild(pageDiv);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
 const textContent=await page.getTextContent(),textLayer=document.createElement('div');textLayer.className='textLayer';pageDiv.appendChild(textLayer);
 for(const item of textContent.items){if(!('str' in item))continue;const tx=pdfjsLib.Util.transform(viewport.transform,item.transform),span=document.createElement('span');span.textContent=item.str;span.dataset.pdfX=String(item.transform[4]);span.dataset.pdfY=String(item.transform[5]);span.dataset.pdfW=String(item.width||0);span.dataset.pdfH=String(item.height||Math.abs(item.transform[3])||0);span.style.left=tx[4]+'px';span.style.top=(tx[5]-Math.abs(tx[3]))+'px';span.style.fontSize=Math.abs(tx[3])+'px';textLayer.appendChild(span)}
}
document.addEventListener('mouseup',()=>{const selection=window.getSelection(),quote=selection?selection.toString().trim():'';if(!selection||!quote||selection.rangeCount===0)return;const range=selection.getRangeAt(0),startEl=range.startContainer.nodeType===3?range.startContainer.parentElement:range.startContainer,endEl=range.endContainer.nodeType===3?range.endContainer.parentElement:range.endContainer,startPage=startEl?.closest?.('.page'),endPage=endEl?.closest?.('.page');if(!startPage||startPage!==endPage){status.textContent='Select text within one page';return}const spans=Array.from(startPage.querySelectorAll('.textLayer span')).filter(span=>selection.containsNode(span,true)),xs=[],ys=[],x2s=[],y2s=[];for(const span of spans){const x=Number(span.dataset.pdfX),y=Number(span.dataset.pdfY),w=Number(span.dataset.pdfW),h=Number(span.dataset.pdfH);if([x,y,w,h].every(Number.isFinite)){xs.push(x);ys.push(y);x2s.push(x+w);y2s.push(y+h)}}const rect=xs.length?[Math.min(...xs),Math.min(...ys),Math.max(...x2s),Math.max(...y2s)]:undefined;pendingSelection={page:Number(startPage.dataset.page),quote,rect};commentBox.style.display='flex';commentInput.value='';commentInput.focus()});
document.getElementById('saveComment').addEventListener('click',()=>{if(!pendingSelection)return;const comment=commentInput.value.trim();if(comment)vscode.postMessage({type:'addComment',...pendingSelection,comment})});
document.getElementById('cancelComment').addEventListener('click',()=>{pendingSelection=null;commentBox.style.display='none';window.getSelection()?.removeAllRanges()});
window.addEventListener('message',event=>{if(event.data?.type==='commentAdded'){status.textContent='Comment added';pendingSelection=null;commentBox.style.display='none';window.getSelection()?.removeAllRanges()}});
</script></body></html>`
  }
}

export function registerPdfPreview(): void {
  window.registerCustomEditorProvider('seal-code.pdfPreview', new PdfPreviewProvider(), { supportsMultipleEditorsPerDocument: true })
}
