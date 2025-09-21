import React, { useState } from 'react';
import axios from 'axios';
import '../styles/UploadForm.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export default function UploadForm() {
  const [text, setText] = useState('');
  const [level, setLevel] = useState('lay');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSimplify() {
    setError(null);
    if (!text || text.trim().length < 10) {
      setError('Please paste a longer piece of text to simplify.');
      return;
    }
    setLoading(true);
    try {
      const res = await axios.post(`${API_BASE}/api/simplify`, {
        text,
        reading_level: level,
        uploader_id: 'demo-user'
      }, { timeout: 120000 });

      // result expected: { bundle_id, simplified, retrieved_chunk_ids, audit_link }
      const result = res.data;
      // keep latest on window for easy inspection / chat component
      window.lexiLastBundle = result.bundle_id;
      window.lexiLastResult = result;

      // dispatch event so other components update without prop drilling
      window.dispatchEvent(new CustomEvent('lexiclear:simplified', { detail: result }));

      // optional: give user feedback (we could also reset text)
    } catch (err) {
      console.error('Simplify error', err);
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setError(String(msg));
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setText('');
    setError(null);
  }

  return (
    <div className="upload-card">
      <h2>LexiClear — Simplify Legal Text</h2>

      <div className="upload-area">
        <textarea
          className="upload-textarea"
          placeholder="Paste NDA, contract, or other legal text here..."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <div className="upload-controls">
        <label className="small" style={{ marginRight: 6 }}>Reading Level:</label>
        <select
          className="upload-select"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="lay">Layperson</option>
          <option value="business">Business</option>
          <option value="lawyer">Lawyer</option>
        </select>

        <button
          className="upload-btn upload-btn-primary"
          onClick={handleSimplify}
          disabled={loading}
        >
          {loading ? 'Simplifying...' : 'Simplify'}
        </button>

        <button
          className="upload-btn upload-btn-ghost"
          onClick={handleClear}
        >
          Clear
        </button>
      </div>

      {error && <div style={{ marginTop: 10, color: '#b91c1c' }}>{error}</div>}
      <div className="footer-note" style={{ marginTop: 12 }}>
        By simplifying, you agree the text may be processed temporarily for demonstration. Not legal advice.
      </div>
    </div>
  );
}
