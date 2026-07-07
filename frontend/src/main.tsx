import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@excalidraw/excalidraw/index.css'
import './index.css'
import App from './App.tsx'
import { configureDisplayFont } from './utils/displayFont'
import { diagnostics } from './lib/diagnostics'

configureDisplayFont()
// Bug tracker: install global error hooks + the periodic error-flush timer
// as early as possible so a crash during boot is still captured.
diagnostics.install()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
