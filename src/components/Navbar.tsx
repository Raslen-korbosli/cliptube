import { useEffect, useState } from 'react';
import { Moon, Scissors, Sun } from 'lucide-react';
import { APP_CONFIG } from '../config';

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

export default function Navbar() {
  const [isDark, setIsDark] = useState(true);

  // Dark is the default; a saved choice wins.
  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem('theme');
    } catch {
      // storage unavailable
    }
    const dark = saved ? saved === 'dark' : true;
    setIsDark(dark);
    applyTheme(dark);
  }, []);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    applyTheme(next);
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // storage unavailable
    }
  };

  return (
    <header className="ct-nav">
      <div className="ct-nav-inner">
        <a className="ct-brand" href="/" aria-label={`${APP_CONFIG.logoPrefix}${APP_CONFIG.logoSuffix} home`}>
          <span className="ct-brand-mark" aria-hidden="true">
            <Scissors size={16} strokeWidth={2.4} />
          </span>
          <span className="ct-brand-name">
            {APP_CONFIG.logoPrefix}
            {APP_CONFIG.logoSuffix}
          </span>
        </a>

        <button
          type="button"
          className="ct-btn ct-btn-quiet ct-btn-sm"
          onClick={toggleTheme}
          aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
        >
          {isDark ? <Sun size={15} /> : <Moon size={15} />}
          <span className="ct-hide-sm">{isDark ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </header>
  );
}
