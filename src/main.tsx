import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only console handle: `__mv.store.getState()` etc. Stripped from builds.
if (import.meta.env.DEV) {
  void (async () => {
    const [{ useStore }, { engine }, midiIO, Tone, instruments] = await Promise.all([
      import('./model/store'),
      import('./audio/engine'),
      import('./model/midiIO'),
      import('tone'),
      import('./audio/instruments'),
    ]);
    (window as unknown as Record<string, unknown>).__mv = {
      store: useStore, engine, midiIO, Tone, instruments,
    };
  })();
}
