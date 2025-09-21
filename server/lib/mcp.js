// server/lib/mcp.js
// Responsible for creating and managing MCP bundles (Model Context Protocol bundles).
// Functions:
//  - createBundleForText(text, opts)
//  - loadBundle(bundleId)
//  - getChunkById(bundleId, chunkId)
//  - listBundles()
//  - deleteBundle(bundleId)

// Usage: const { createBundleForText } = require('./mcp');

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'bundles');
const DEFAULT_CHUNK_TOKENS = 500; // approximate target tokens per chunk
const DEFAULT_CHUNK_OVERLAP = 50; // approx tokens overlap between chunks

// Ensure the storage directory exists
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (err) {
    // ignore if already exists
  }
}

// Simple approximate token estimator: characters / 4
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Naive sentence splitter using punctuation. Keeps abbreviations imperfectly,
 * but works well for most legal prose as a fallback (for hackathon/demo).
 */
function splitIntoSentences(text) {
  // Normalize spaces
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  // Split on sentence enders followed by space + capital or line break OR end of text.
  // This is intentionally simple and conservative.
  const pattern = /(?<=\S[.!?])\s+(?=[A-Z0-9"“‘\[]|$)/g;
  const raw = normalized.split(pattern);

  // Fallback: if no split made, return the whole text as single "sentence"
  return raw.length ? raw.map(s => s.trim()).filter(Boolean) : [normalized];
}

/**
 * Chunk text into chunks of approximate token size, with optional overlap.
 * Strategy:
 *  - First split by paragraphs (double newline), then by sentence.
 *  - Greedily pack sentences into chunks until target token size reached.
 *
 * @param {string} text
 * @param {object} options
 * @returns {Array<{ text: string, start_char: number, end_char: number }>}
 */
function chunkText(text, options = {}) {
  const targetTokens = options.targetTokens || DEFAULT_CHUNK_TOKENS;
  const overlapTokens = options.overlapTokens || DEFAULT_CHUNK_OVERLAP;

  // Quick return
  if (!text || !text.trim()) return [];

  // Normalize newlines
  const normalized = text.replace(/\r\n/g, '\n');

  // Split into paragraphs first to respect structure
  const paragraphs = normalized.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  const chunks = [];
  let globalCharIndex = 0; // track char offset within original text

  // We'll walk through paragraphs and sentences, building chunks
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    const sentences = splitIntoSentences(para);
    let currentChunkSentences = [];
    let currentChunkStart = null;
    let currentChunkTokens = 0;
    let localIndex = 0; // char index within the paragraph

    // Helper to flush current chunk
    function flushChunk(finalizeOverlap = false) {
      if (currentChunkSentences.length === 0) return;
      const chunkText = currentChunkSentences.join(' ').trim();
      // find start/end char offsets relative to the whole text
      const startChar = currentChunkStart;
      const endChar = startChar + chunkText.length;
      chunks.push({ text: chunkText, start_char: startChar, end_char: endChar });
      if (finalizeOverlap && overlapTokens > 0) {
        // Prepare next chunk with overlap: keep last sentences approximating overlapTokens
        const keep = [];
        let keepTokens = 0;
        for (let i = currentChunkSentences.length - 1; i >= 0; i--) {
          const s = currentChunkSentences[i];
          const t = estimateTokens(s);
          if (keepTokens + t > overlapTokens && keep.length > 0) break;
          keep.unshift(s);
          keepTokens += t;
        }
        currentChunkSentences = keep.slice();
        currentChunkTokens = keepTokens;
        // adjust start char to reflect overlap sentences start
        // compute the offset for the first kept sentence inside the chunkText
        const keepText = currentChunkSentences.join(' ');
        const keepIndexInChunk = chunkText.indexOf(keepText);
        if (keepIndexInChunk >= 0) {
          // new start is old start + index
          currentChunkStart = startChar + keepIndexInChunk;
        } else {
          // fallback: set start to endChar (next char)
          currentChunkStart = endChar;
        }
      } else {
        currentChunkSentences = [];
        currentChunkTokens = 0;
        currentChunkStart = null;
      }
    }

    // Walk sentences
    for (let i = 0; i < sentences.length; i++) {
      const sent = sentences[i];
      const sentTokens = estimateTokens(sent);

      // Determine the absolute char index of this sentence in the whole document.
      // We compute by searching for the sentence starting at or after globalCharIndex.
      // This is simple and tolerant for duplicated sentences (should be fine for our uses).
      let absoluteSentenceIndex = text.indexOf(sent, globalCharIndex);
      if (absoluteSentenceIndex === -1) {
        // fallback: try searching from 0 (rare)
        absoluteSentenceIndex = text.indexOf(sent);
      }
      if (absoluteSentenceIndex === -1) {
        // if still not found, approximate using last known index
        absoluteSentenceIndex = globalCharIndex;
      }

      if (currentChunkSentences.length === 0) {
        currentChunkStart = absoluteSentenceIndex;
      }

      currentChunkSentences.push(sent);
      currentChunkTokens += sentTokens;

      // If we've reached or exceeded targetTokens, flush the chunk
      if (currentChunkTokens >= targetTokens) {
        // flush with overlap (keep some sentences for next chunk)
        flushChunk(true);
        // move globalCharIndex forward to end of flushed chunk to speed up future searches
        globalCharIndex = chunks[chunks.length - 1].end_char;
      } else {
        // move globalCharIndex to end of this sentence to help next search
        globalCharIndex = absoluteSentenceIndex + sent.length;
      }
    }

    // After finishing paragraph, flush remaining sentences (no overlap across paragraphs)
    if (currentChunkSentences.length > 0) {
      flushChunk(false);
      globalCharIndex = chunks[chunks.length - 1].end_char;
    }
  }

  // Final safety: merge very small chunks into neighbors
  const merged = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const t = estimateTokens(c.text);
    if (t < Math.max(50, Math.floor(DEFAULT_CHUNK_TOKENS / 5)) && merged.length > 0) {
      // append to previous
      merged[merged.length - 1].text += ' ' + c.text;
      merged[merged.length - 1].end_char = c.end_char;
    } else {
      merged.push(Object.assign({}, c));
    }
  }

  return merged;
}

// compute sha256 checksum of text (hex)
function computeChecksum(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// create unique bundle id
function makeBundleId() {
  const timestamp = Date.now();
  const short = uuidv4().split('-')[0];
  return `bundle-${timestamp}-${short}`;
}

/**
 * Create an MCP bundle from plain text.
 * @param {string} text - original document text
 * @param {object} opts - optional metadata: { title, uploader_id, language, origin_url, chunkOptions }
 * @returns {Promise<object>} bundle object saved on disk
 */
async function createBundleForText(text, opts = {}) {
  if (!text || !text.trim()) {
    throw new Error('Text must be provided to create a bundle.');
  }

  await ensureStorageDir();

  const bundleId = makeBundleId();
  const createdAt = new Date().toISOString();
  const docTitle = opts.title || 'uploaded_doc';
  const uploaderId = opts.uploader_id || 'anonymous';
  const language = opts.language || null;

  // chunking
  const chunkOptions = opts.chunkOptions || {};
  const rawChunks = chunkText(text, chunkOptions);

  // Build chunk objects with offsets and simple metadata
  const chunks = rawChunks.map((c, idx) => {
    const chunkId = `${bundleId}-chunk-${String(idx + 1).padStart(3, '0')}`;
    return {
      chunk_id: chunkId,
      start_char: c.start_char,
      end_char: c.end_char,
      text: c.text,
      tokens: estimateTokens(c.text),
      origin_page: null, // could be filled by PDF parser if available
      section_header: null,
      embedding_id: null // placeholder for later when embedding
    };
  });

  // Compute checksum of original text
  const checksum = computeChecksum(text);

  const bundle = {
    bundle_id: bundleId,
    doc_title: docTitle,
    created_at: createdAt,
    uploader_id: uploaderId,
    language,
    source_checksum: checksum,
    chunks,
    index_metadata: {
      vector_db: opts.vector_db || 'local-faiss',
      index_version: opts.index_version || 'v1',
      embedding_model: opts.embedding_model || process.env.EMBED_MODEL || null,
      chunking_strategy: opts.chunking_strategy || 'paragraph+sentences'
    },
    access_policy: {
      retention_days: typeof opts.retention_days === 'number' ? opts.retention_days : (process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 7),
      encrypted: !!opts.encrypted,
      consent_given: opts.consent_given !== undefined ? !!opts.consent_given : true
    },
    // optional extras
    source_url: opts.origin_url || null,
    original_text_length: text.length
  };

  // Persist to disk
  const filePath = path.join(STORAGE_DIR, `${bundleId}.json`);
  await fs.writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8');

  return bundle;
}

/**
 * Load a stored bundle by id
 * @param {string} bundleId
 * @returns {Promise<object|null>}
 */
async function loadBundle(bundleId) {
  if (!bundleId) throw new Error('bundleId required');
  const filePath = path.join(STORAGE_DIR, `${bundleId}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Find a specific chunk in a bundle by chunkId
 * @param {string} bundleId
 * @param {string} chunkId
 * @returns {Promise<object|null>}
 */
async function getChunkById(bundleId, chunkId) {
  const bundle = await loadBundle(bundleId);
  if (!bundle) return null;
  const found = (bundle.chunks || []).find(c => c.chunk_id === chunkId);
  return found || null;
}

/**
 * List all bundles available in storage (returns minimal metadata)
 * @returns {Promise<Array<{ bundle_id, doc_title, created_at, uploader_id }>>}
 */
async function listBundles() {
  await ensureStorageDir();
  const files = await fs.readdir(STORAGE_DIR);
  const bundles = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(path.join(STORAGE_DIR, f), 'utf8');
    try {
      const b = JSON.parse(raw);
      bundles.push({
        bundle_id: b.bundle_id,
        doc_title: b.doc_title,
        created_at: b.created_at,
        uploader_id: b.uploader_id,
        chunk_count: (b.chunks || []).length
      });
    } catch (e) {
      // skip invalid
    }
  }
  // sort by created_at desc
  bundles.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return bundles;
}

/**
 * Delete a bundle (and its file) - respects access policy (caller should check privileges)
 * @param {string} bundleId
 * @returns {Promise<boolean>} true if deleted
 */
async function deleteBundle(bundleId) {
  const filePath = path.join(STORAGE_DIR, `${bundleId}.json`);
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  createBundleForText,
  loadBundle,
  getChunkById,
  listBundles,
  deleteBundle,
  // export chunkText if you want to reuse externally
  chunkText,
  estimateTokens
};
