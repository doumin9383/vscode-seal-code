# External annotation inbox

External tools can add review comments without calling a SealCode-specific API by writing JSON files into:

```text
.codereview/inbox/*.json
```

The extension watches this directory, resolves each text quote back to a workspace-relative file location, imports the comment into the normal review store, and deletes the inbox file after every annotation in it has been handled successfully.

## Schema

```json
{
  "version": 1,
  "annotations": [
    {
      "id": "pdf-review-0187",
      "document": {
        "path": "paper/main.tex"
      },
      "anchor": {
        "type": "text",
        "quote": "The proposed method significantly improves performance.",
        "startLine": 142,
        "endLine": 142
      },
      "comment": "The claim is stronger than the result supports. Please weaken it.",
      "category": "suggestion"
    }
  ]
}
```

`id`, `document.path`, `anchor.type`, `anchor.quote`, and `comment` are required. `document.path` is relative to the first VS Code workspace folder. `startLine` and `endLine` are optional hints. When the hinted lines do not contain the quote, or when no line hints are supplied, the extension searches the document for the exact quote and derives the line range from the first match.

Annotation IDs are idempotency keys. An annotation whose ID is already present in the review store is skipped rather than duplicated.

Supported categories are `bug`, `question`, `suggestion`, `nitpick`, and `note`; missing or unknown categories fall back to `note`.

## Intended adapters

The inbox is deliberately agent-neutral. A PDF viewer bridge, Markdown preview, TeX preview, browser extension, or another review UI can all emit the same envelope. Future PDF support can add an `anchor.type = "pdf"` variant with page geometry while retaining the same `document`, `id`, and `comment` structure.
