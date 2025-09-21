// server/lib/embeddings.js
// Utilities for calling OpenAI (chat completions) and embeddings.
// Dependencies: node-fetch@2, dotenv
//
// Usage:
//   const { callOpenAI, getEmbedding, batchGetEmbeddings } = require('./embeddings');
//   const resp = await callOpenAI([{role:'system', content:'You are...'}, {role:'user', content:'Hi'}]);
//   const emb = await getEmbedding("Some text");

require('dotenv').config();
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn('WARNING: OPENAI_API_KEY not set in environment.');
}

const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 500;

/**
 * Basic exponential-backoff retry helper.
 * @param {Function} fn async function that returns a Promise
 * @param {number} retries
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const wait = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(`Call failed (attempt ${attempt}). Retrying in ${wait}ms. Error: ${err.message || err}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Call the OpenAI Chat Completions endpoint.
 * Returns the raw parsed JSON response.
 * 
 * messages: [{role:'system'|'user'|'assistant', content: '...'}, ...]
 * max_tokens: number (optional)
 */
async function callOpenAI(messages, max_tokens = 800, model = LLM_MODEL, temperature = 0.0) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not configured');

  const body = {
    model,
    messages,
    max_tokens,
    temperature
  };

  return withRetry(async () => {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`OpenAI Chat API error ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return json;
  });
}

/**
 * Get a single embedding vector for `text`.
 * Returns an array of floats.
 */
async function getEmbedding(text, model = EMBED_MODEL) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not configured');
  if (typeof text !== 'string') text = String(text);

  const body = {
    input: text,
    model
  };

  return withRetry(async () => {
    const res = await fetch(`${OPENAI_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`OpenAI Embeddings API error ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    if (!json.data || !json.data[0] || !json.data[0].embedding) {
      throw new Error('Unexpected embeddings response: ' + JSON.stringify(json));
    }
    return json.data[0].embedding;
  });
}

/**
 * Batch embeddings for an array of texts.
 * Returns array of embeddings in the same order as texts.
 * batchSize controls how many texts we send per request (OpenAI supports batching).
 */
async function batchGetEmbeddings(texts = [], batchSize = 16, model = EMBED_MODEL) {
  if (!Array.isArray(texts)) throw new Error('texts must be an array');

  const embeddings = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    // For embeddings endpoint we can pass array of inputs
    const body = { input: batch, model };
    const resJson = await withRetry(async () => {
      const res = await fetch(`${OPENAI_BASE}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const txt = await res.text();
        const err = new Error(`OpenAI embeddings batch error ${res.status}: ${txt}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });

    if (!resJson.data || !Array.isArray(resJson.data)) {
      throw new Error('Unexpected batch embeddings response: ' + JSON.stringify(resJson));
    }

    // resJson.data[i] corresponds to batch[i]
    for (const item of resJson.data) {
      if (!item || !item.embedding) {
        embeddings.push(null);
      } else {
        embeddings.push(item.embedding);
      }
    }
    // small throttle to be safe
    await new Promise((r) => setTimeout(r, 100));
  }
  return embeddings;
}

/**
 * Compute cosine similarity between two vectors (arrays).
 */
function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  if (a.length !== b.length) {
    // if lengths differ, compute up to min length
    const min = Math.min(a.length, b.length);
    a = a.slice(0, min);
    b = b.slice(0, min);
  }
  let dot = 0.0, norma = 0.0, normb = 0.0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    norma += a[i] * a[i];
    normb += b[i] * b[i];
  }
  if (norma === 0 || normb === 0) return 0;
  return dot / (Math.sqrt(norma) * Math.sqrt(normb));
}

/**
 * Save embeddings map to a JSON file (helpful for local dev).
 * embeddingsMap: { id1: [float,...], id2: [...], ... }
 */
function saveEmbeddingsToFile(embeddingsMap = {}, filepath = './server/storage/embeddings.json') {
  try {
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(embeddingsMap, null, 2), 'utf8');
    return filepath;
  } catch (err) {
    throw new Error('Failed to save embeddings: ' + err.message);
  }
}

/**
 * Load embeddings from file (if exists). Returns object map or {}.
 */
function loadEmbeddingsFromFile(filepath = './server/storage/embeddings.json') {
  try {
    if (!fs.existsSync(filepath)) return {};
    const content = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('Failed to load embeddings file', err.message);
    return {};
  }
}

module.exports = {
  callOpenAI,
  getEmbedding,
  batchGetEmbeddings,
  cosineSimilarity,
  saveEmbeddingsToFile,
  loadEmbeddingsFromFile
};
