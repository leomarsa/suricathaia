export type Theme = 'dark' | 'light'

export function getTheme(): Theme {
  return (localStorage.getItem('suricatha_theme') as Theme) || 'dark'
}

export function applyTheme(t: Theme) {
  if (t === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
  localStorage.setItem('suricatha_theme', t)
}
