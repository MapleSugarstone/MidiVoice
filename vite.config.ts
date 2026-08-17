import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative asset paths so the same build works from localhost AND from a
  // GitHub Pages subpath like https://user.github.io/midivoice/.
  base: './',
  server: {
    // PORT lets the Claude Code preview assign a free port; 5273 otherwise.
    port: Number(process.env.PORT) || 5273,
    open: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  worker: {
    // The transcription worker lazily imports the neural model, and dynamic
    // imports inside a worker need ES output (the iife default can't split).
    format: 'es',
  },
});
