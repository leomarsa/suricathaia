import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { getTheme, applyTheme } from './theme'

applyTheme(getTheme())

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
