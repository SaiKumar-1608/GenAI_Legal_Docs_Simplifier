/**
 * server/scripts/create_sample_bundle.js
 *
 * Usage:
 *   node create_sample_bundle.js ../sample_docs/sample_NDA.txt
 *
 * What it does:
 *  - Reads a text file (sample legal doc).
 *  - Splits the text into chunks (sentence-aware, with a target chunk size).
 *  - Computes a sha256 checksum of the original text.
 *  - Builds an MCP-style bundle JSON containing metadata + chunk objects.
 *  - Saves the bundle to server/storage/bundles/<bundle_id>.json
 *
 * Notes:
 *  - This is a lightweight utility intended for hackathon/demo usage.
 *  - For production you should use a more robust chunker (tokenizer-aware),
 *    include page/origin offsets from PDF parsing, and integrate real embedding ids.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

if (require.main === module) {
  (async () => {
    try {
      const argv = process.argv.slice(2);
      if (!argv[0]) {
        console.error('Usage: node create_sample_bundle.js <path-to-text-file> [--chunk-size N] [--overlap M]');
        process.exit(1);
      }
      const filePath = path.resolve(argv[0]);
      const chunkSize = parseInt(getArgValue('--chunk-size') || '1200', 10); // approx chars, not tokens
      const overlap = parseInt(getArgValue('--overlap') || '200', 10);

      if (!fs.existsSync(filePath)) {
        console.error('File not found:', filePath);
        process.exit(1);
      }

      const rawText = fs.readFileSync(filePath, 'utf8');
      const bundle = createBundleFromText(rawText, {
        sourceFilename: path.basename(filePath),
        chunkSize,
        overlap,
      });

      const bundlesDir = path.join(__dirname, '..', 'storage', 'bundles');
      fs.mkdirSync(bundlesDir, { recursive: true });

      const outPath = path.join(bundlesDir, `${bundle.bundle_id}.json`);
      fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2), 'utf8');

      console.log('Bundle created:', outPath);
      console.log('bundle_id:', bundle.bundle_id);
    } catch (err) {
      console.error('Error:', err);
      process.exit(1);
    }
  })();
}

/**
 * Helper: get CLI argument value for flags like --chunk-size
 */
function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv.length > idx + 1) return process.argv[idx + 1];
  return null;
}

/**
 * Create an MCP bundle JSON from plain text.
 * Options:
 *  - sourceFilename: string
 *  - chunkSize: approx target chunk size in characters (defaults 1200)
 *  - overlap: number of overlapping characters between chunks (defaults 200)
 */
function createBundleFromText(text, options = {}) {
  const { sourceFilename = 'uploaded_doc.txt', chunkSize = 1200, overlap = 200 } = options;

  const bundle_id = `bundle-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const created_at = new Date().toISOString();
  const source_checksum = sha256Hex(text);

  // Chunk the text in a sentence-aware way
  const rawChunks = sentenceAwareChunker(text, chunkSize, overlap);

  // Map into chunk objects
  const chunks = rawChunks.map((chunkText, i) => {
    const chunk_id = `${bundle_id}-chunk-${i + 1}`;
    return {
      chunk_id,
      start_char: chunkText._start, // numeric indices into original text
      end_char: chunkText._end,
      text: chunkText.text,
      embedding_id: null, // placeholder, to be filled when embeddings are computed
      tokens: estimateTokens(chunkText.text),
      section_header: null,
      origin_page: null,
    };
  });

  const bundle = {
    bundle_id,
    doc_title: sourceFilename,
    created_at,
    source_checksum: `sha256:${source_checksum}`,
    language: detectLanguageSimple(text),
    chunks,
    index_metadata: {
      vector_db: 'local-faiss',
      index_version: 'v1',
      embedding_model: process.env.EMBED_MODEL || 'openai-embed-placeholder',
      chunking_strategy: `sentence-aware-${chunkSize}-chars-overlap-${overlap}`,
    },
    access_policy: {
      retention_days: parseInt(process.env.RETENTION_DAYS || '7', 10),
      encrypted: false,
      consent_given: true,
    },
    // optional: keep a tiny preview for UI
    preview: text.slice(0, 600).replace(/\s+/g, ' ') + (text.length > 600 ? '...' : ''),
  };

  return bundle;
}

/**
 * sentenceAwareChunker
 * - Splits the text into sentence boundaries, then groups sentences into chunks
 *   trying to keep each chunk's character length around targetChunkSize.
 * - Returns array of { text, _start, _end } maintaining char offsets.
 */
function sentenceAwareChunker(text, targetChunkSize = 1200, overlap = 200) {
  // Simple sentence splitter using punctuation. Not perfect but sufficient for a demo.
  const sentenceEndRegex = /(?<=\S[.!?])\s+(?=[A-Z0-9"“‘\u00C0-\u024F])/g;
  // fallback: if regex fails, split by newline
  let sentences = text.split(sentenceEndRegex);

  // If extremely long single sentences exist, break them by commas/spaces to avoid too-large chunks
  sentences = sentences.flatMap(s => {
    if (s.length > targetChunkSize * 1.5) {
      // split by commas then fallback to slicing
      const parts = s.split(/,\s+/);
      if (parts.length > 1) return parts;
      // hard-split
      const result = [];
      for (let i = 0; i < s.length; i += targetChunkSize) {
        result.push(s.slice(i, i + targetChunkSize));
      }
      return result;
    }
    return s;
  });

  // Build chunks by accumulating sentences
  const chunks = [];
  let current = '';
  let currentStart = 0;
  let charCursor = 0;

  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const sTrim = s; // keep original spacing for offsets
    const sStart = text.indexOf(sTrim, charCursor);
    const sEnd = sStart + sTrim.length;
    charCursor = sEnd;

    if (current.length === 0) {
      currentStart = sStart;
    }
    if ((current.length + sTrim.length) <= targetChunkSize || current.length === 0) {
      // append to current chunk
      current += (current.length > 0 ? ' ' : '') + sTrim;
    } else {
      // close current chunk
      const chunkObj = {
        text: current.trim(),
        _start: currentStart,
        _end: sStart - 1,
      };
      chunks.push(chunkObj);

      // start new chunk with overlap
      const overlapStart = Math.max(0, currentStart + Math.max(0, current.length - overlap));
      current = text.slice(overlapStart, sEnd).trim();
      currentStart = overlapStart;
    }
  }

  // push final chunk
  if (current && current.trim().length > 0) {
    const finalStart = currentStart;
    const finalEnd = Math.min(text.length, finalStart + current.length);
    chunks.push({ text: current.trim(), _start: finalStart, _end: finalEnd });
  }

  // If no chunks created (empty doc), create a single chunk
  if (chunks.length === 0) {
    return [{ text: text.trim(), _start: 0, _end: text.length }];
  }

  return chunks;
}

/**
 * estimateTokens - rough heuristic to convert chars -> tokens
 * (tokens ~= chars / 4). This is sufficient for demo metadata.
 */
function estimateTokens(s) {
  return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * sha256Hex - compute hex sha256 digest of a string
 */
function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * detectLanguageSimple - tiny heuristic: check for high-ASCII unicode or presence of common english words
 * For demo only. In production use a library or language-detection model.
 */
function detectLanguageSimple(text) {
  if (!text || text.trim().length === 0) return 'unknown';
  // quick check for presence of non-latin scripts
  if (/[\u0400-\u04FF\u0600-\u06FF\u0400-\u052F\u4E00-\u9FFF]/.test(text)) {
    return 'non-latin';
  }
  // fallback: assume English
  return 'en';
}
