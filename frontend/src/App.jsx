import React from 'react';
import UploadForm from './components/UploadForm.jsx';
import SimplifyView from './components/SimplifyView.jsx';
import ChatAsk from './components/ChatAsk.jsx';
import './styles/App.css'; // new global styles for layout & header

export default function App() {
  return (
    <div className="container">
      {/* Header */}
      <header className="header">
        <div className="brand">
          <div className="logo">LC</div>
          <div>
            <h1 className="title">LexiClear</h1>
            <p className="subtitle">Simplify Legal Documents</p>
          </div>
        </div>
      </header>

      {/* Grid Layout */}
      <div className="grid">
        {/* Left column: Upload + Simplify results */}
        <div>
          <UploadForm />
          <SimplifyView />
        </div>

        {/* Right column: ChatAsk */}
        <div>
          <ChatAsk />
        </div>
      </div>

      {/* Footer */}
      <footer className="footer-note">
        ⚖️ LexiClear provides simplified summaries. This is <strong>not legal advice</strong> — please consult a lawyer for critical decisions.
      </footer>
    </div>
  );
}
