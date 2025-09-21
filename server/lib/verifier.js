/**
 * server/lib/verifier.js
 *
 * Lightweight verifier utilities for LexiClear.
 * - Verifies that LLM outputs cite valid chunk_ids from an MCP bundle.
 * - Verifies quoted snippets (or short substrings) are present in the referenced chunks (exact or normalized match).
 * - Heuristically flags potentially hallucinated sentences (claims that look factual/legal but lack citations).
 *
 * NOTE: This is a heuristic layer — it helps detect obvious issues (missing citations, mismatched snippets),
 * but it is not a formal legal verification tool. Use human review for high-risk results.
 *
 * Exports:
 *  - extractChunkIds(text) -> Array<string>
 *  - verifyResponseAgainstBundle(bundle, responseText, options) -> Promise<VerificationResult>
 *  - verifyQAAnswer(bundle, answerText, retrievedChunkIds, options) -> Promise<VerificationResult>
 *
 * VerificationResult:
 * {
 *   ok: boolean, // true when no critical problems found
 *   cited_chunks: [chunk_id...],
 *   unknown_chunk_ids: [chunk_id...], // chunk ids cited by response but not in bundle
 *   matched_snippets: [{ chunk_id, snippet, matched: boolean, match_type:'exact'|'normalized'|'none' }],
 *   missing_snippet_matches: [ ... ], // matched_snippets items where matched===false
 *   potential_hallucinations: [ { sentence, reason } ],
 *   stats: { num_chunks_in_bundle, num_cited_chunks, citation_coverage }
 * }
 *
 * Simple heuristics:
 *  - Extract chunk_ids using regex /\b(bundle-[\w-]+-chunk-\d+)\b/
 *  - For each chunk_id found, attempt to find an exact quoted snippet in the response (text in quotes) and verify it appears in the chunk.
 *  - If no quotes found, attempt to match short substrings (first 40 chars of the chunk) in a normalized way (lowercase, whitespace normalized).
 *  - Potential hallucination sentences: sentences that contain legal-keywords (e.g., "terminate", "indemnify") but have no chunk_id mentioned nearby.
 *
 * Author: ChatGPT (adapted for your project)
 */

const fs = require('fs');
const path = require('path');

/** --- Config / heuristics --- */
const DEFAULT_OPTIONS = {
  // Minimum substring length for normalized matching (characters)
  normalizedMatchMinLen: 30,
  // Sentence tokenizer (simple): split on period, question, exclamation
  sentenceSplitterRegex: /(?<=\.)\s+|(?<=\?)\s+|(?<=\!)\s+/,
  // If a sentence contains one of these keywords but there is NO chunk_id in the sentence => flag as potential hallucination
  legalKeywords: [
    'terminate', 'termination', 'notice', 'indemnify', 'indemnity', 'waive', 'warranty',
    'liability', 'liable', 'penalty', 'breach', 'breaches', 'governing law', 'jurisdiction',
    'confidential', 'confidentiality', 'obligation', 'rights', 'termination', 'renewal',
    'notice period', 'non-compete', 'severability', 'assignment', 'arbitration'
  ],
  // If true: return early with "ok=false" if any unknown chunk_ids are found
  failOnUnknownChunkId: false
};

/** Regex used to extract chunk ids in responses (customize to your bundle naming) */
const CHUNK_ID_REGEX = /\b(bundle-[A-Za-z0-9._:-]+-chunk-\d+)\b/g;

/** Utility: normalize text (lowercase, collapse whitespace) */
function normalizeText(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Extract chunk ids from a piece of text using CHUNK_ID_REGEX */
function extractChunkIds(text) {
  if (!text || typeof text !== 'string') return [];
  const ids = new Set();
  let m;
  while ((m = CHUNK_ID_REGEX.exec(text)) !== null) {
    ids.add(m[1]);
  }
  return Array.from(ids);
}

/** Helper: build a map of chunks by chunk_id from a bundle */
function mapChunksById(bundle) {
  const map = new Map();
  if (!bundle || !Array.isArray(bundle.chunks)) return map;
  for (const c of bundle.chunks) {
    if (c && c.chunk_id) map.set(c.chunk_id, c);
  }
  return map;
}

/** Helper: extract quoted snippets from response text (double or single quotes) */
function extractQuotedSnippets(text) {
  if (!text || typeof text !== 'string') return [];
  const snippets = [];
  // match "..." or '...'
  const dq = /"([^"]{5,500})"/g; // allow snippets between quotes of reasonable length
  const sq = /'([^']{5,500})'/g;
  let m;
  while ((m = dq.exec(text)) !== null) snippets.push(m[1]);
  while ((m = sq.exec(text)) !== null) snippets.push(m[1]);
  return snippets;
}

/** Helper: find whether snippet appears in chunk text (exact or normalized) */
function doesSnippetMatchChunk(snippet, chunkText, options = {}) {
  if (!snippet || !chunkText) return { matched: false, match_type: 'none' };
  // exact match
  if (chunkText.includes(snippet)) return { matched: true, match_type: 'exact' };
  // normalized match (lowercase, whitespace collapse)
  const nSnippet = normalizeText(snippet);
  const nChunk = normalizeText(chunkText);
  if (nSnippet.length >= (options.normalizedMatchMinLen || DEFAULT_OPTIONS.normalizedMatchMinLen)
      && nChunk.includes(nSnippet)) {
    return { matched: true, match_type: 'normalized' };
  }
  // also try fuzzy prefix match (first N chars of snippet)
  const prefixLen = Math.min(40, nSnippet.length);
  if (prefixLen >= 12) {
    const prefix = nSnippet.slice(0, prefixLen);
    if (nChunk.includes(prefix)) return { matched: true, match_type: 'prefix' };
  }
  return { matched: false, match_type: 'none' };
}

/**
 * verifyResponseAgainstBundle
 * Verify an LLM response (simplified doc or structured string) against an MCP bundle.
 *
 * @param {Object} bundle - MCP bundle JSON object (must contain bundle.chunks array with chunk_id & text)
 * @param {string} responseText - LLM response string (may include chunk_ids and quoted snippets)
 * @param {Object} [opts] - optional overrides for heuristics
 *
 * @returns {Promise<Object>} VerificationResult (see top comment)
 */
async function verifyResponseAgainstBundle(bundle, responseText, opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const result = {
    ok: true,
    cited_chunks: [],
    unknown_chunk_ids: [],
    matched_snippets: [],
    missing_snippet_matches: [],
    potential_hallucinations: [],
    stats: {
      num_chunks_in_bundle: (bundle && Array.isArray(bundle.chunks)) ? bundle.chunks.length : 0,
      num_cited_chunks: 0,
      citation_coverage: 0
    }
  };

  if (!bundle || !Array.isArray(bundle.chunks)) {
    result.ok = false;
    result.error = 'Invalid bundle: no chunks';
    return result;
  }

  const chunkMap = mapChunksById(bundle);

  // 1) Extract chunk ids the response cited
  const cited = extractChunkIds(responseText);
  result.cited_chunks = cited;
  result.stats.num_cited_chunks = cited.length;

  // 2) Identify any cited chunk ids not present in bundle
  result.unknown_chunk_ids = cited.filter(id => !chunkMap.has(id));
  if (options.failOnUnknownChunkId && result.unknown_chunk_ids.length > 0) {
    result.ok = false;
    return result;
  }

  // 3) Extract quoted snippets from response (if any)
  const quotedSnippets = extractQuotedSnippets(responseText);

  // 4) For each cited chunk id, attempt to verify snippet matches the chunk
  for (const chunkId of cited) {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) {
      // already recorded unknown_chunk_ids; record a failed snippet match entry
      result.matched_snippets.push({ chunk_id: chunkId, snippet: null, matched: false, match_type: 'none' });
      continue;
    }

    // find any quoted snippet that appears to belong to this chunk.
    // Heuristic: check each quoted snippet for exact/normalized match against this chunk text.
    let found = false;
    for (const snippet of quotedSnippets) {
      const check = doesSnippetMatchChunk(snippet, chunk.text, options);
      if (check.matched) {
        result.matched_snippets.push({
          chunk_id: chunkId,
          snippet,
          matched: true,
          match_type: check.match_type
        });
        found = true;
        break;
      }
    }

    // If no quoted snippet found, try to detect a short substring from the chunk present in the response
    if (!found) {
      // try using the first 60 chars of the chunk (normalized) as a search target
      const probe = normalizeText(chunk.text).slice(0, 120);
      if (probe.length >= 12 && normalizeText(responseText).includes(probe)) {
        result.matched_snippets.push({
          chunk_id: chunkId,
          snippet: chunk.text.slice(0, Math.min(200, chunk.text.length)),
          matched: true,
          match_type: 'chunk-prefix'
        });
        found = true;
      }
    }

    if (!found) {
      // no snippet match for this cited chunk
      result.matched_snippets.push({ chunk_id: chunkId, snippet: null, matched: false, match_type: 'none' });
      result.missing_snippet_matches.push({ chunk_id: chunkId });
    }
  }

  // 5) Heuristic: flag sentences that look like factual/legal claims but contain no chunk ids
  // Split into sentences and examine ones with legal keywords but without chunk ids
  const sentences = (responseText || '').split(options.sentenceSplitterRegex).map(s => s.trim()).filter(Boolean);
  for (const sent of sentences) {
    const low = sent.toLowerCase();
    // skip if sentence contains a chunk id (we consider it cited)
    if (CHUNK_ID_REGEX.test(sent)) continue;

    for (const kw of options.legalKeywords) {
      if (low.includes(kw)) {
        // found legal keyword in sentence with no chunk id — flag as potential hallucination
        result.potential_hallucinations.push({
          sentence: sent,
          reason: `contains legal keyword "${kw}" but no chunk_id cited`
        });
        break;
      }
    }
  }

  // 6) Simple stats
  result.stats.citation_coverage = (result.stats.num_cited_chunks > 0)
    ? Math.min(1, result.stats.num_cited_chunks / Math.max(1, result.stats.num_chunks_in_bundle))
    : 0;

  // 7) Decide ok/fail: heuristics
  // We consider it problematic if:
  //   - There are unknown chunk ids (response referenced chunk ids not in bundle)
  //   - OR there are cited chunks with no matched snippet
  //   - OR there are potential hallucination sentences (and no way to verify)
  if (result.unknown_chunk_ids.length > 0 || result.missing_snippet_matches.length > 0 || result.potential_hallucinations.length > 0) {
    result.ok = false;
  } else {
    result.ok = true;
  }

  return result;
}

/**
 * verifyQAAnswer
 * Specialized verify function when you also have the retrievedChunkIds that your retriever returned.
 * This verifies that:
 *  - The answer cites at least one of the retrievedChunkIds OR contains a matched snippet from one of them.
 *
 * @param {Object} bundle - MCP bundle
 * @param {string} answerText - model answer string
 * @param {Array<string>} retrievedChunkIds - chunk ids returned by retriever (top-k)
 * @param {Object} [opts]
 * @returns {Promise<Object>} VerificationResult (same shape as verifyResponseAgainstBundle)
 */
async function verifyQAAnswer(bundle, answerText, retrievedChunkIds = [], opts = {}) {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const baseResult = await verifyResponseAgainstBundle(bundle, answerText, options);

  // Add extra QA-specific checks
  baseResult.retrieved_chunk_ids = Array.isArray(retrievedChunkIds) ? retrievedChunkIds : [];

  // Check intersection between cited_chunks and retrieved_chunk_ids
  const citedSet = new Set(baseResult.cited_chunks || []);
  const retrievedSet = new Set(baseResult.retrieved_chunk_ids || []);
  const intersection = [...citedSet].filter(x => retrievedSet.has(x));
  baseResult.cited_retrieved_intersection = intersection;
  baseResult.cites_retrieved = intersection.length > 0;

  // If the answer doesn't cite any of the retrieved chunks, attempt to match any snippet from retrieved chunks in the answer
  if (!baseResult.cites_retrieved && baseResult.retrieved_chunk_ids.length > 0) {
    const chunkMap = mapChunksById(bundle);
    const matchedFromRetrieved = [];
    for (const rid of baseResult.retrieved_chunk_ids) {
      const chunk = chunkMap.get(rid);
      if (!chunk) continue;
      // check if any quoted snippet or prefix from chunk is in the answer
      const quoted = extractQuotedSnippets(answerText);
      let found = false;
      for (const snippet of quoted) {
        const check = doesSnippetMatchChunk(snippet, chunk.text, options);
        if (check.matched) {
          matchedFromRetrieved.push({ chunk_id: rid, snippet, match_type: check.match_type });
          found = true;
          break;
        }
      }
      if (!found) {
        const probe = normalizeText(chunk.text).slice(0, 120);
        if (probe.length >= 12 && normalizeText(answerText).includes(probe)) {
          matchedFromRetrieved.push({ chunk_id: rid, snippet: chunk.text.slice(0, 120), match_type: 'chunk-prefix' });
          found = true;
        }
      }
    }
    if (matchedFromRetrieved.length > 0) {
      baseResult.cites_retrieved = true;
      baseResult.matched_from_retrieved = matchedFromRetrieved;
    }
  }

  // Final OK decision for QA: require cites_retrieved == true and baseResult.ok true
  baseResult.ok = baseResult.ok && baseResult.cites_retrieved;

  return baseResult;
}

module.exports = {
  extractChunkIds,
  verifyResponseAgainstBundle,
  verifyQAAnswer,
  // exported for testing or reuse
  _internals: {
    CHUNK_ID_REGEX,
    normalizeText,
    extractQuotedSnippets,
    doesSnippetMatchChunk,
    mapChunksById
  }
};
