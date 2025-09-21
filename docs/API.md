# LexiClear API Documentation

This document describes the REST API endpoints for the **LexiClear** backend.  
All endpoints are served under the base URL (default: `http://localhost:4000` in development).

---

## Authentication

- **Hackathon MVP:** No authentication is required.  
- **Production (future):** Add JWT or OAuth 2.0 for securing uploads and user sessions.

---

## Endpoints

### 1. `POST /api/simplify`

Simplifies a legal document into plain-English guidance, clause-level rewrites, and risk notes.  
Also creates an MCP bundle for provenance and traceability.

#### Request Body

```json
{
  "text": "Full contract or legal text here...",
  "reading_level": "lay",   // optional: "lay" | "business" | "lawyer"
  "uploader_id": "user-123" // optional: identifier for uploader
}
