import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// Grab the root div from index.html
const rootEl = document.getElementById('root');

// Attach React app to the DOM
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
