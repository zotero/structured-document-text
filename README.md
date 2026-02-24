# Structured Document Text

Structured, normalized text for PDFs, EPUBs, and snapshots, with more formats planned (e.g., OCR images, transcribed audio).

## Core principles
- [`document-worker`](https://github.com/zotero/pdf-worker/tree/document-worker) is the sole structured-text producer
- Every block/text node maps back to the source file
- Structured text alone must support all text-based annotations
- Preserve internal reference links among inline and block nodes, but leave relationship types for consumers to infer
- The outline is the primary index for document structure

## Use cases
- Reading mode (Desktop/iOS/Android/Web) with text annotations
- Text layer for the Zotero Reader PDF viewer
- Structured data for agents
- Section-level chunking for embeddings
- Outline preview outside the Reader (e.g., in the item pane)

## Performance goals (WIP)
### Requirements
- Instant access to any structured-text region
- Low memory use during long-lived in-memory access
- Random access when stored on disk or in S3
- Low storage overhead

### Design decisions
- Large JSON is slow and memory-heavy, so store gzipped, sharded JSON chunks with a top-level index (effectively binary)
- For PDFs, node-to-position maps are strings since they dominate size
