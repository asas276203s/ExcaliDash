import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import './index.css'
import App from './App.tsx'
import { configureDisplayFont } from './utils/displayFont'
import { diagnostics } from './lib/diagnostics'
import { startAssetVersionPolling } from './utils/assetVersionPoll'

configureDisplayFont()
// Bug tracker: install global error hooks + the periodic error-flush timer
// as early as possible so a crash during boot is still captured.
diagnostics.install()
// Frontend-bundle update detection: poll /version.json and prompt for reload
// when a newer frontend deploy ships (backend header path is blind to
// frontend-only deploys). No-op in local dev/test (no baked version).
startAssetVersionPolling()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
