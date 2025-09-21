# MCP Schema — LexiClear

**MCP (Model Context Protocol)** is the structured format we use to represent legal documents after upload.  
Every document is split into *chunks*, assigned stable identifiers, and bundled into a JSON object called an **MCP Bundle**.  

The MCP ensures:
- Provenance (every simplified output or Q&A can trace back to the exact chunk of source text)
- Reproducibility (bundle checksum + index version guarantee same context can be reused later)
- Privacy & Governance (access policies, retention metadata)
- Auditability (bundle can be exported and inspected)

---

## Top-level structure

```json
{
  "bundle_id": "string",
  "doc_title": "string",
  "uploader_id": "string",
  "created_at": "ISO8601 timestamp",
  "source_checksum": "sha256:hexstring",
  "language": "string (ISO 639-1 code, e.g. 'en')",
  "jurisdiction": "string (e.g. 'US-NY', 'IN', 'EU')",
  "chunks": [ { ...chunk objects... } ],
  "index_metadata": { ... },
  "access_policy": { ... }
}
