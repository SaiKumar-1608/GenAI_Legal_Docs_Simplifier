// server/routes/simplify.js
//
// POST /api/simplify
// Body: { text: "...", reading_level?: "lay"|"business"|"lawyer", uploader_id?: "user-123" }
//
// Response:
// {
//   bundle_id: "...",
//   result: { overall_summary: "...", clauses: [...], raw_llm: "..." },
//   retrieved_chunk_ids: [...],
//   audit_file: "/storage/bundles/<bundle_id>-result.json"
// }

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;

const { createBundleForText } = require('../lib/mcp'); // Must export createBundleForText(text, opts)
const { callOpenAI } = require('../lib/embeddings');  // Must export callOpenAI(messages, max_tokens)

const BUNDLES_DIR = path.join(__dirname, '..', 'storage', 'bundles');

/**
 * Utility: ensure bundles dir exists (async)
 */
async function ensureBundlesDir() {
  try {
    await fs.mkdir(BUNDLES_DIR, { recursive: true });
  } catch (e) {
    // ignore - will throw on write if something wrong
  }
}

/**
 * Truncate a text to roughly n characters (safe for including as preview).
 * Keeps full text for small chunks.
 */
function previewText(text, maxChars = 1200) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + ' ... [truncated]';
}

/**
 * Build the instruction prompt for the LLM.
 * We instruct the model to output JSON only (structured).
 */
function buildPrompt(retrievedChunks, reading_level = 'lay') {
  // System instruction focusing on faithfulness and provenance
  const system = `You are a careful legal assistant. STRICT RULES:
1) Use ONLY the provided SOURCE CHUNKS below to produce any factual claim or summary.
2) For every clause-level simplification include the chunk_id that the explanation is grounded on.
3) If the answer cannot be found in the SOURCE CHUNKS, respond with "Not in document" for that field.
4) Be conservative: if something is ambiguous, say "Consult a lawyer".
5) Output MUST BE JSON only, with the exact structure requested (no extra commentary).

Reading level hint: ${reading_level}
`;

  // User message: include the retrieved chunks and the JSON schema request
  const sourcesText = retrievedChunks.map(c => {
    // Include chunk id and a preview of text
    return `[${c.chunk_id}] ${previewText(c.text, 2000)}`;
  }).join('\n\n');

  const user = `SOURCES:\n${sourcesText}

TASK:
1) Provide "overall_summary": a concise 2-4 sentence plain-English summary of the document at the requested reading level.
2) Provide "clauses": an array where each item has:
   - chunk_id: the chunk id used
   - original: the original chunk text (or a preview)
   - simplified: a one-sentence plain-English rewrite of that chunk
   - why_it_matters: one short line explaining practical effect
   - risk: one of ["Low","Medium","High"] and a one-line reason
3) Provide "notes": optional array of any warnings, or [] if none.

Return JSON with the schema:
{
  "overall_summary": "...",
  "clauses": [
    {
      "chunk_id": "...",
      "original": "...",
      "simplified": "...",
      "why_it_matters": "...",
      "risk": "Low|Medium|High - short reason"
    }
  ],
  "notes": []
}

Remember: use ONLY the SOURCE CHUNKS above. If you must infer, mark it as "Consult a lawyer".
`;

  // Return messages array compatible with Chat Completion style APIs
  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/**
 * Main handler
 */
router.post('/', async (req, res) => {
  try {
    const text = req.body?.text;
    const reading_level = req.body?.reading_level || 'lay';
    const uploader_id = req.body?.uploader_id || 'demo-user';

    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return res.status(400).json({ error: 'Please provide reasonable "text" to simplify.' });
    }

    // ensure storage dir exists
    await ensureBundlesDir();

    // 1) Create MCP bundle (chunks + metadata) - this writes a bundle JSON into storage/bundles
    const bundle = await createBundleForText(text, { uploader_id, title: req.body?.title || 'uploaded_doc' });
    // bundle is expected to contain: bundle.bundle_id and bundle.chunks array

    // 2) Choose representative/retrieved chunks for the simplify task.
    // For hackathon/demo we take first N chunks (in production you'd cluster/select by importance)
    const MAX_CHUNKS = 8;
    const retrievedChunks = (bundle.chunks || []).slice(0, MAX_CHUNKS);

    // 3) Build prompt/messages
    const messages = buildPrompt(retrievedChunks, reading_level);

    // 4) Call the LLM via callOpenAI helper
    // callOpenAI should accept (messagesArray, max_tokens) and return provider response
    // We expect it to return an object with choices[0].message.content OR a string
    let llmResp;
    try {
      llmResp = await callOpenAI(messages, 1200); // max tokens for response (adjust as needed)
    } catch (err) {
      console.error('LLM call failed:', err);
      return res.status(500).json({ error: 'LLM provider error', details: String(err) });
    }

    // 5) Extract textual content from provider response
    let llmText = '';
    if (!llmResp) {
      llmText = '';
    } else if (typeof llmResp === 'string') {
      llmText = llmResp;
    } else if (llmResp?.choices && Array.isArray(llmResp.choices) && llmResp.choices.length > 0) {
      // OpenAI-style response
      const msg = llmResp.choices[0].message;
      llmText = (msg && msg.content) ? msg.content : JSON.stringify(llmResp.choices[0]);
    } else if (llmResp?.output) {
      // some other wrapper
      llmText = typeof llmResp.output === 'string' ? llmResp.output : JSON.stringify(llmResp.output);
    } else {
      // fallback
      llmText = JSON.stringify(llmResp);
    }

    // 6) Try parse JSON result (the prompt asked for JSON-only). If JSON parse fails, return raw LLM text.
    let parsed = null;
    try {
      // Attempt to find the first JSON object in the LLM text
      const firstBrace = llmText.indexOf('{');
      if (firstBrace >= 0) {
        const jsonCandidate = llmText.slice(firstBrace);
        parsed = JSON.parse(jsonCandidate);
      } else {
        parsed = null;
      }
    } catch (parseErr) {
      parsed = null;
    }

    // 7) Build result object to save for audit and respond
    const result = {
      bundle_id: bundle.bundle_id,
      bundle_title: bundle.doc_title,
      retrieved_chunk_ids: retrievedChunks.map(c => c.chunk_id),
      raw_llm: llmText,
      parsed: parsed, // may be null if parsing failed
      timestamp: new Date().toISOString(),
      reading_level
    };

    // 8) Persist result to an audit file so judges / users can inspect later
    const auditFilename = path.join(BUNDLES_DIR, `${bundle.bundle_id}-result.json`);
    try {
      await fs.writeFile(auditFilename, JSON.stringify(result, null, 2), 'utf8');
    } catch (werr) {
      console.warn('Failed to write audit file:', werr);
    }

    // 9) Respond to client with structured info (prefer parsed JSON if available)
    const responsePayload = {
      bundle_id: bundle.bundle_id,
      bundle_title: bundle.doc_title,
      retrieved_chunk_ids: result.retrieved_chunk_ids,
      audit_file: `/storage/bundles/${path.basename(auditFilename)}`,
      simplified: parsed ? parsed : llmText
    };

    return res.json(responsePayload);
  } catch (err) {
    console.error('Unexpected error in /api/simplify:', err);
    return res.status(500).json({ error: 'Internal server error', detail: String(err) });
  }
});

module.exports = router;
