import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted font (no external CDN) — keeps the app on-box and offline-capable.
import '@fontsource-variable/hanken-grotesk/index.css'
import App from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
