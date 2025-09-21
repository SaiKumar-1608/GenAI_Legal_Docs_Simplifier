// server/index.js
// LexiClear server (demo-ready)
// - Exports `app` for tests (no auto-listen when required)
// - Starts HTTP server only when run directly (node index.js)
// - CORS enabled for demo
// - Basic MCP bundle creation (chunking + embeddings stored locally)
// - /api/simplify, /api/ask, /api/audit, /health

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// fetch: Node 18+ has global.fetch; fallback to node-fetch if absent
let fetchFn;
if (typeof fetch === 'function') {
  fetchFn = fetch;
} else {
  try {
    fetchFn = require('node-fetch');
  } catch (e) {
    console.error('Fatal: no fetch available. Install node-fetch for Node < 18.');
    process.exit(1);
  }
}

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error('ERROR: OPENAI_API_KEY not found in environment.');
  console.error('Make sure you have a .env file in server/ with: OPENAI_API_KEY=sk-xxxx');
  process.exit(1);
}

function maskKey(k) {
  if (!k || k.length < 10) return '****';
  return `${k.slice(0,6)}...${k.slice(-4)}`;
}

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const PORT = Number(process.env.PORT || 4000);
const BUNDLES_DIR = path.join(__dirname, 'storage', 'bundles');

if (!fs.existsSync(BUNDLES_DIR)) fs.mkdirSync(BUNDLES_DIR, { recursive: true });

const app = express();

// Middleware
app.use(cors()); // demo: allow all origins
app.use(bodyParser.json({ limit: '10mb' }));

console.log(`LexiClear starting (PORT=${PORT})`);
console.log(`OPENAI_API_KEY=${maskKey(OPENAI_KEY)}`);
console.log(`EMBED_MODEL=${EMBED_MODEL}  LLM_MODEL=${LLM_MODEL}`);
console.log(`Bundles directory: ${BUNDLES_DIR}`);

/* ---------------------
   Utilities
   ---------------------*/

function chunkText(text, approxChunkChars = 3000) {
  const paragraphs = text.split(/\n{1,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const p of paragraphs) {
    if ((buffer ? buffer.length + p.length + 2 : p.length) <= approxChunkChars) {
      buffer = buffer ? `${buffer}\n\n${p}` : p;
    } else {
      if (buffer) chunks.push(buffer);
      if (p.length > approxChunkChars) {
        for (let i = 0; i < p.length; i += approxChunkChars) {
          chunks.push(p.slice(i, i + approxChunkChars));
        }
        buffer = '';
      } else {
        buffer = p;
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function saveBundle(bundle) {
  const file = path.join(BUNDLES_DIR, `${bundle.bundle_id}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');
}

function loadBundle(bundle_id) {
  const file = path.join(BUNDLES_DIR, `${bundle_id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ---------------------
   OpenAI wrappers (embeddings + chat)
   - These use fetchFn and are easy to mock in tests by overriding global.fetch
   ---------------------*/

async function createEmbedding(inputText) {
  const url = 'https://api.openai.com/v1/embeddings';
  const payload = { model: EMBED_MODEL, input: inputText };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const j = await resp.json();
      if (j?.data && j.data[0]?.embedding) return j.data[0].embedding;
      throw new Error('Embedding unexpected response: ' + JSON.stringify(j));
    } catch (err) {
      console.warn(`createEmbedding attempt ${attempt+1} failed: ${err.message || err}`);
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

async function callOpenAIChat(messages, max_tokens = 800, temperature = 0.0) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const payload = { model: LLM_MODEL, messages, max_tokens, temperature };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      const j = await resp.json();
      if (j?.choices && j.choices[0]?.message?.content) {
        return j.choices[0].message.content;
      }
      throw new Error('LLM unexpected response: ' + JSON.stringify(j));
    } catch (err) {
      console.warn(`callOpenAIChat attempt ${attempt+1} failed: ${err.message || err}`);
      if (attempt === 1) throw err;
      await new Promise(r => setTimeout(r, 300));
    }
  }
}

/* ---------------------
   Vector helpers
   ---------------------*/
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosineSim(a, b) { const nA = norm(a), nB = norm(b); if (nA === 0 || nB === 0) return 0; return dot(a, b) / (nA * nB); }

/* ---------------------
   Bundle creator (MCP-style JSON)
   ---------------------*/
async function createBundleForText(text, opts = {}) {
  const bundle_id = `bundle-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const chunksRaw = chunkText(text);
  const chunks = [];
  for (let i = 0; i < chunksRaw.length; i++) {
    const ctext = chunksRaw[i];
    const chunk_id = `${bundle_id}-chunk-${i + 1}`;
    let embedding = null;
    try {
      embedding = await createEmbedding(ctext);
    } catch (err) {
      console.warn('Embedding failed for chunk; storing null embedding. Error:', err.message || err);
    }
    chunks.push({
      chunk_id,
      text: ctext,
      tokens: Math.ceil(ctext.length / 4),
      embedding
    });
  }

  const bundle = {
    bundle_id,
    doc_title: opts.title || 'uploaded_doc',
    created_at: new Date().toISOString(),
    source_checksum: `sha256:${sha256Hex(text)}`,
    language: opts.language || 'unknown',
    chunks,
    index_metadata: {
      vector_db: 'local-file',
      index_version: 'v1',
      embedding_model: EMBED_MODEL,
      chunking_strategy: 'paragraph-boundary'
    },
    access_policy: {
      retention_days: opts.retention_days || 7,
      encrypted: false,
      consent_given: true
    }
  };

  saveBundle(bundle);
  return bundle;
}

/* ---------------------
   Routes
   ---------------------*/

/**
 * POST /api/simplify
 * body: { text, reading_level }
 */
app.post('/api/simplify', async (req, res) => {
  try {
    const { text, reading_level = 'lay', uploader_id = 'demo-user' } = req.body;
    if (!text || text.trim().length < 10) return res.status(400).json({ error: 'Provide text to simplify (body.text)' });

    // create bundle (chunks + embeddings)
    const bundle = await createBundleForText(text, { title: 'uploaded_doc', uploader_id });

    // pick topK chunks (demo: first N)
    const topK = Math.min(8, bundle.chunks.length);
    const retrieved = bundle.chunks.slice(0, topK);

    // strict prompt using only retrieved chunks (provenance)
    const systemMsg = {
      role: 'system',
      content: 'You are a careful legal assistant. Use ONLY the SOURCE CHUNKS provided below to produce concise and faithful plain-English simplifications. For every factual/legal claim, include the chunk_id and quote the exact snippet used. If the answer is not found in the provided chunks, say "Not in document".'
    };

    const sourcesText = retrieved.map(c => `[${c.chunk_id}] ${c.text}`).join('\n\n');

    const userInstruction = {
      role: 'user',
      content: `Simplify the provided legal content for a ${reading_level} audience.
Output format:
1) OVERALL SUMMARY: (2-4 sentences)
2) CLAUSE REWRITES:
 - [chunk_id] Plain-English rewrite
 - Risk: Low/Medium/High (one-line)
3) CITATIONS: include the exact chunk_id(s) you used.

SOURCES:
${sourcesText}

Now produce the output.`
    };

    const llmResponse = await callOpenAIChat([systemMsg, userInstruction], 1000, 0.0);

    res.json({
      bundle_id: bundle.bundle_id,
      simplified: llmResponse,
      retrieved_chunk_ids: retrieved.map(c => c.chunk_id),
      audit_link: `/api/audit/${bundle.bundle_id}`
    });
  } catch (err) {
    console.error('Error /api/simplify:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /api/ask
 * body: { bundle_id, question, top_k }
 */
app.post('/api/ask', async (req, res) => {
  try {
    const { bundle_id, question, top_k = 4 } = req.body;
    if (!bundle_id || !question) return res.status(400).json({ error: 'Provide bundle_id and question' });

    const bundle = loadBundle(bundle_id);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

    const qEmb = await createEmbedding(question);

    const sims = [];
    for (const c of bundle.chunks) {
      if (!c.embedding) continue;
      const s = cosineSim(qEmb, c.embedding);
      sims.push({ chunk: c, score: s });
    }

    sims.sort((a, b) => b.score - a.score);
    const selected = sims.slice(0, top_k).map(s => ({ chunk: s.chunk, score: s.score }));

    const systemMsg = {
      role: 'system',
      content: 'You are a careful legal assistant. Use ONLY the SOURCE CHUNKS below to answer the user question. Quote the snippet and chunk_id for any factual claim. If the answer cannot be found in the provided chunks, say "Not in document". Keep answers concise.'
    };

    const sourcesText = selected.map(s => `[${s.chunk.chunk_id}] ${s.chunk.text}`).join('\n\n');

    const userMsg = {
      role: 'user',
      content: `QUESTION: ${question}\n\nSOURCES:\n${sourcesText}\n\nAnswer the question using ONLY the sources above and include chunk_id citations.`
    };

    const answer = await callOpenAIChat([systemMsg, userMsg], 600, 0.0);

    res.json({
      bundle_id,
      answer,
      retrieved_chunk_ids: selected.map(s => s.chunk.chunk_id),
      similarity_scores: selected.map(s => ({ chunk_id: s.chunk.chunk_id, score: s.score }))
    });
  } catch (err) {
    console.error('Error /api/ask:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/audit/:bundle_id
 * Return stored bundle. (Note: contains embeddings; you may strip them on frontend)
 */
app.get('/api/audit/:bundle_id', (req, res) => {
  const { bundle_id } = req.params;
  const bundle = loadBundle(bundle_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  res.json(bundle);
});

/* Health & root */
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: Date.now() }));
app.get('/', (req, res) => res.send('LexiClear server running. Use /api/simplify or /api/ask.'));

/* Export app for tests */
module.exports = app;

/* ---------------------
   Start HTTP server only when run directly (prevents tests from trying to bind port)
   ---------------------*/
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });

  function shutdown() {
    console.log('Shutting down server...');
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('Forcing shutdown.');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at promise', p, 'reason:', reason);
  });
  process.on('uncaughtException', err => {
    console.error('Uncaught Exception thrown', err);
  });
}
