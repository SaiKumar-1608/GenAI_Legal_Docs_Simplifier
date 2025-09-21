import React, { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import '../styles/ChatAsk.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export default function ChatAsk() {
  const [query, setQuery] = useState('');
  const [messages, setMessages] = useState([]); // { role: 'user'|'assistant', text }
  const [loading, setLoading] = useState(false);
  const [bundleId, setBundleId] = useState(() => window.lexiLastBundle || null);
  const [auditBundle, setAuditBundle] = useState(null);
  const messagesRef = useRef();

  useEffect(() => {
    // listen for new simplified bundles
    function onSimplified(e) {
      const b = e.detail?.bundle_id;
      setBundleId(b || window.lexiLastBundle || null);
      // clear previous chat messages on new bundle
      setMessages([]);
      // optionally load the audit bundle JSON
      if (b) {
        axios.get(`${API_BASE}/api/audit/${b}`).then(r => setAuditBundle(r.data)).catch(() => setAuditBundle(null));
      }
    }
    window.addEventListener('lexiclear:simplified', onSimplified);
    return () => window.removeEventListener('lexiclear:simplified', onSimplified);
  }, []);

  // scrolling to bottom on new messages
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleAsk() {
    if (!query || !bundleId) {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Please upload a document first (so we know which bundle to search).' }]);
      return;
    }
    setLoading(true);
    // show user message
    setMessages(prev => [...prev, { role: 'user', text: query }]);
    try {
      const res = await axios.post(`${API_BASE}/api/ask`, { bundle_id: bundleId, question: query }, { timeout: 60000 });
      const ans = res.data?.answer || JSON.stringify(res.data);
      setMessages(prev => [...prev, { role: 'assistant', text: ans }]);
    } catch (err) {
      console.error('Ask error', err);
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setMessages(prev => [...prev, { role: 'assistant', text: `Error: ${msg}` }]);
    } finally {
      setLoading(false);
      setQuery('');
    }
  }

  return (
    <div className="chat-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Document Q&amp;A</h4>
        <div className="small muted">{bundleId ? `Bundle: ${bundleId}` : 'No bundle selected'}</div>
      </div>

      <div className="chat">
        <div className="messages" ref={messagesRef}>
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role === 'user' ? 'user' : ''}`}>
              <div className="bubble">{m.text}</div>
            </div>
          ))}
        </div>

        <div className="chat-input" style={{ marginTop: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={bundleId ? "Ask a question about the uploaded doc..." : "Upload & simplify a doc first"}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAsk(); }}
            disabled={loading}
          />
          <button className="upload-btn upload-btn-primary" onClick={handleAsk} disabled={loading}>
            {loading ? 'Asking...' : 'Ask'}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <button
          className="upload-btn upload-btn-ghost"
          onClick={() => { setAuditBundle(null); if (bundleId) axios.get(`${API_BASE}/api/audit/${bundleId}`).then(r => setAuditBundle(r.data)).catch(()=>setAuditBundle(null)); }}
        >
          Load Audit
        </button>
      </div>
    </div>
  );
}
