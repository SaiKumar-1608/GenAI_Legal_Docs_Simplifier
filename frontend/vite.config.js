import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// If you used VITE_API_BASE in .env, Vite will inject import.meta.env.VITE_API_BASE
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});
