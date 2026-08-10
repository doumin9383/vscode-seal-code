export type CommentCategory = 'bug' | 'question' | 'suggestion' | 'nitpick' | 'note'

export interface PdfAnnotationMetadata {
  page: number
  rect?: number[]
  quadPoints?: number[]
}

export interface Comment {
  id: string
  filePath: string
  startLine: number
  endLine: number
  quote: string
  text: string
  category: CommentCategory
  pdf?: PdfAnnotationMetadata
  createdAt: string
  updatedAt: string
}
