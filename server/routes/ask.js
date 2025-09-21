// server/routes/ask.js
// POST /api/ask
// Body: { bundle_id: string, question: string, top_k?: number }
// Response: { answer, retrieved_chunk_ids, retrieved_chunks, hallucination, log_id }

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const STORAGE_DIR = path.join(__dirname, '..', 'storage');
const BUNDLES_DIR = path.join(STORAGE_DIR, 'bundles');
const LOGS_DIR = path.join(STORAGE_DIR, 'logs');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// Config / env
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn('WARNING: OPENAI_API_KEY not set. Set it in .env before running.');
}
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const TOP_K_DEFAULT = parseInt(process.env.TOP_K_DEFAULT || '4', 10);

// Helpers ---------------------------------------------------------------

async function callOpenAIEmbeddings(texts) {
  // texts: array of strings
  const url = 'https://api.openai.com/v1/embeddings';
  const body = {
    model: EMBED_MODEL,
    input: texts
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Embedding request failed: ${res.status} ${txt}`);
  }
  const j = await res.json();
  // j.data is array of { embedding: [...] }
  return j.data.map(d => d.embedding);
}

async function callOpenAIChat(messages, max_tokens = 512, temperature = 0.0) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: LLM_MODEL,
    messages,
    max_tokens,
    temperature
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Chat request failed: ${res.status} ${txt}`);
  }
  const j = await res.json();
  const choice = j.choices && j.choices[0];
  const content = choice?.message?.content ?? '';
  return { raw: j, content };
}

function cosineSimilarity(a, b) {
  // a,b: numeric arrays
  let dot = 0.0, na = 0.0, nb = 0.0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] || 0;
    const bi = b[i] || 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function readBundle(bundle_id) {
  const p = path.join(BUNDLES_DIR, `${bundle_id}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Bundle not found: ${bundle_id}`);
  }
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function saveBundle(bundle) {
  const p = path.join(BUNDLES_DIR, `${bundle.bundle_id}.json`);
  fs.writeFileSync(p, JSON.stringify(bundle, null, 2), 'utf8');
}

function safeSnippet(text, maxLength = 400) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// Core: ensure chunks have embeddings cached in bundle
async function ensureBundleEmbeddings(bundle) {
  // bundle.chunks = [{ chunk_id, text, embedding? }]
  const chunksWithoutEmb = bundle.chunks.filter(c => !c.embedding);
  if (chunksWithoutEmb.length === 0) return bundle;

  // Create embeddings in batches (batch size depends on provider; keep small)
  const BATCH = 16;
  for (let i = 0; i < chunksWithoutEmb.length; i += BATCH) {
    const batch = chunksWithoutEmb.slice(i, i + BATCH);
    const texts = batch.map(c => c.text);
    const embs = await callOpenAIEmbeddings(texts);
    for (let j = 0; j < batch.length; j++) {
      const c = batch[j];
      c.embedding = embs[j];
      // optionally add embedding_id or fingerprint
      c.embedding_id = c.embedding_id || `emb-${crypto.createHash('sha1').update(c.text).digest('hex').slice(0,12)}`;
    }
  }

  // Save bundle with embeddings for caching
  saveBundle(bundle);
  return bundle;
}

// Retrieve top-k relevant chunks given a question
async function retrieveTopK(bundle, question, k = TOP_K_DEFAULT) {
  // Ensure embeddings exist for chunks
  await ensureBundleEmbeddings(bundle);

  // Embed the question
  const qEmbArr = await callOpenAIEmbeddings([question]);
  const qEmb = qEmbArr[0];

  // Calculate similarities
  const scored = bundle.chunks.map(c => {
    const sim = c.embedding ? cosineSimilarity(qEmb, c.embedding) : 0;
    return { chunk: c, score: sim };
  });

  // Sort desc and pick top k
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k).map(s => ({ ...s, snippet: safeSnippet(s.chunk.text, 600) }));
  return { qEmb, top }; // top: [{chunk, score, snippet}]
}

// Compose strict prompt with retrieved chunks
function assemblePrompt(retrieved, question) {
  // retrieved: [{chunk, score, snippet}]
  const system = `You are a careful legal assistant. Use ONLY the provided SOURCE CHUNKS to answer. \
For any factual claim, quote the exact snippet and the chunk_id. If the information cannot be found in the sources, respond exactly: "Not in document". \
Be concise and conservative. If the snippet is ambiguous, say "Consult a lawyer."`;

  const sourcesText = retrieved.map((r, idx) => {
    const chunkId = r.chunk.chunk_id;
    const header = `[${chunkId}] (score: ${r.score.toFixed(3)})`;
    return `${header}\n"${safeSnippet(r.chunk.text, 1000)}"`;
  }).join('\n\n');

  const user = `SOURCES:\n${sourcesText}\n\nQuestion: ${question}\n\nAnswer. Include source chunk_ids used.`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  return messages;
}

// Simple post-check: does the answer include at least one chunk_id from retrieved?
function checkForCitations(answerText, retrieved) {
  const ids = retrieved.map(r => r.chunk.chunk_id);
  for (const id of ids) {
    if (answerText.includes(id)) return { cited: true, cited_ids: ids.filter(i => answerText.includes(i)) };
  }
  return { cited: false, cited_ids: [] };
}

// Logging utility
function writeLog(log) {
  const logId = uuidv4();
  const p = path.join(LOGS_DIR, `${logId}.json`);
  fs.writeFileSync(p, JSON.stringify(log, null, 2), 'utf8');
  return logId;
}

// Route handler --------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { bundle_id, question, top_k } = req.body;
    if (!bundle_id || !question) {
      return res.status(400).json({ error: 'bundle_id and question are required in body' });
    }
    // 1) load bundle
    let bundle;
    try {
      bundle = readBundle(bundle_id);
    } catch (err) {
      return res.status(404).json({ error: `bundle not found: ${bundle_id}` });
    }

    // 2) retrieve top-k chunks
    const k = top_k && Number.isInteger(top_k) ? top_k : TOP_K_DEFAULT;
    const { qEmb, top } = await retrieveTopK(bundle, question, k);

    // 3) assemble prompt (use only retrieved chunks)
    const messages = assemblePrompt(top, question);

    // 4) call LLM
    const llmResult = await callOpenAIChat(messages, 512, 0.0);
    const answer = llmResult.content.trim();

    // 5) post-check for citations / hallucination
    const citationCheck = checkForCitations(answer, top);
    const hallucination = !citationCheck.cited;

    // If hallucination, augment answer with a conservational note (do not modify original content)
    let finalAnswer = answer;
    let hallucination_note = null;
    if (hallucination) {
      hallucination_note = 'WARNING: The response does not contain explicit chunk_id citations from the retrieved sources. Marked for review.';
      // We keep the model output but flag it. (Alternatively we could block the response.)
    }

    // 6) Persist a log for audit & LLMOps
    const logRecord = {
      timestamp: new Date().toISOString(),
      bundle_id,
      question,
      top_k: k,
      retrieved: top.map(t => ({ chunk_id: t.chunk.chunk_id, score: t.score, snippet: t.snippet })),
      prompt: messages,
      model: {
        name: LLM_MODEL
      },
      llm_raw: llmResult.raw, // this can be large; ok for hackathon logs but consider trimming
      citation_check: citationCheck,
      hallucination,
      hallucination_note
    };
    const log_id = writeLog(logRecord);

    // 7) Return structured response
    return res.json({
      answer: finalAnswer,
      hallucination,
      hallucination_note,
      retrieved_chunk_ids: top.map(t => t.chunk.chunk_id),
      retrieved_chunks: top.map(t => ({ chunk_id: t.chunk.chunk_id, score: t.score, snippet: t.snippet })),
      cited_chunk_ids: citationCheck.cited_ids,
      log_id
    });
  } catch (err) {
    console.error('Error in /api/ask:', err);
    return res.status(500).json({ error: String(err) });
  }
});

module.exports = router;
