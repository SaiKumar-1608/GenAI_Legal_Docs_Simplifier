import React, { useEffect, useState } from 'react';
import '../styles/SimplifyView.css';

/**
 * SimplifyView (point-wise rendering)
 * - Listens for 'lexiclear:simplified' events
 * - Parses LLM output into an optional header and numbered items
 * - Renders a clean heading + ordered list with source info per item
 */
export default function SimplifyView() {
  const [result, setResult] = useState(() => window.lexiLastResult || null);
  const [heading, setHeading] = useState('');
  const [items, setItems] = useState([]); // {text, chunk_id}

  useEffect(() => {
    function handler(e) {
      setResult(e.detail);
    }
    window.addEventListener('lexiclear:simplified', handler);
    return () => window.removeEventListener('lexiclear:simplified', handler);
  }, []);

  // convert **bold** to <strong> and escape other HTML
  function boldToHtml(s) {
    if (!s) return '';
    // simple replace for **bold** -> <strong>bold</strong>
    // minimal escaping for < and >
    const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  }

  useEffect(() => {
    if (!result?.simplified) {
      setHeading('');
      setItems([]);
      return;
    }

    const text = result.simplified.trim();

    // Split into lines, keep non-empty lines
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Try to detect a top heading like "**Service Agreement Overview**"
    let idx = 0;
    let detectedHeading = '';
    if (lines[0] && /^\*{2}.+\*{2}$/.test(lines[0])) {
      detectedHeading = lines[0].replace(/^\*{2}/, '').replace(/\*{2}$/, '').trim();
      idx = 1;
    } else if (lines[0] && /^[A-Za-z].{0,80}$/.test(lines[0]) && lines[1] && /^\*{2}.+\*{2}$/.test(lines[1])) {
      // sometimes there's an intro line before header
      detectedHeading = lines[1].replace(/^\*{2}/, '').replace(/\*{2}$/, '').trim();
      idx = 2;
    }

    // Collect numbered items. We'll join lines until we find next numbered marker.
    const parsed = [];
    let current = null;
    for (; idx < lines.length; idx++) {
      const ln = lines[idx];

      // detect numbered bullet like "1." or "1) " or "- " or "- [chunk]"
      const numMatch = ln.match(/^(\d+[\.\)])\s*(.*)/);
      const dashMatch = ln.match(/^[\-\u2022]\s*(.*)/); // - or bullet
      const chunkOnlyMatch = ln.match(/^\[.*bundle-.*chunk-\d+.*\]\s*(.*)/);

      if (numMatch) {
        // new numbered item
        if (current) parsed.push(current);
        current = { text: numMatch[2] || '', chunk_id: null };
      } else if (dashMatch) {
        if (current) parsed.push(current);
        current = { text: dashMatch[1] || '', chunk_id: null };
      } else if (chunkOnlyMatch) {
        // line that starts with a chunk id; attach to previous if exists
        if (!current) current = { text: '', chunk_id: null };
        // try to extract chunk id and append remainder
        const cidMatch = ln.match(/(bundle-[^\s\]]+-chunk-\d+)/);
        if (cidMatch) current.chunk_id = cidMatch[1];
        const remainder = ln.replace(/\[.*?\]/g, '').trim();
        if (remainder) current.text = (current.text + ' ' + remainder).trim();
      } else {
        // continuation line
        if (!current) {
          // start a fallback item if none yet
          current = { text: ln, chunk_id: null };
        } else {
          current.text = (current.text + ' ' + ln).trim();
        }
      }
    }
    if (current) parsed.push(current);

    // As a fallback, if parsed is empty, produce a single item with entire text
    if (parsed.length === 0) {
      parsed.push({ text, chunk_id: result?.retrieved_chunk_ids?.[0] || null });
    }

    // Try to auto-detect chunk ids inside each parsed.text if not already set
    for (const it of parsed) {
      if (!it.chunk_id) {
        const m = it.text.match(/(bundle-[^\s\]]+-chunk-\d+)/);
        if (m) it.chunk_id = m[1];
      }
    }

    setHeading(detectedHeading);
    setItems(parsed);
  }, [result]);

  return (
    <div className="simplify-card">
      <div className="result-header">
        <div>
          <h3 style={{ margin: 0 }}>Simplification</h3>
          <div className="small muted" style={{ marginTop: 6 }}>
            {result?.bundle_id ? `Bundle: ${result.bundle_id}` : 'No simplification result yet.'}
          </div>
        </div>
        <div className="small muted">
          {result?.retrieved_chunk_ids ? `${result.retrieved_chunk_ids.length} chunks used` : ''}
        </div>
      </div>

      {items.length > 0 ? (
        <>
          {heading ? <h4 style={{ marginTop: 6 }}>{heading}</h4> : null}
          <ol style={{ marginTop: 8 }}>
            {items.map((it, i) => (
              <li key={i} style={{ marginBottom: 12 }}>
                <div dangerouslySetInnerHTML={{ __html: boldToHtml(it.text) }} />
                <div className="meta" style={{ marginTop: 6 }}>
                  <div className="tag">Source</div>
                  <div className="muted" style={{ marginLeft: 8 }}>
                    {it.chunk_id || (result?.retrieved_chunk_ids && result.retrieved_chunk_ids.join(', ')) || 'n/a'}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {result?.audit_link && (
            <div style={{ marginTop: 12 }} className="small muted">
              <a href={result.audit_link} target="_blank" rel="noreferrer">Open audit bundle</a>
            </div>
          )}
        </>
      ) : (
        <div className="small muted">No simplification result yet. Upload a document or paste text and click Simplify.</div>
      )}
    </div>
  );
}
