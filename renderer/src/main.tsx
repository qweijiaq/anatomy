import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import './tokens.css'
import './app.css'

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(<App />)
}
