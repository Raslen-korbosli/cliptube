import { useState } from 'react';
import Navbar from './components/Navbar';
import HomePage from './pages/HomePage';
import { APP_CONFIG } from './config';

export default function App() {
  const [hasActiveVideo, setHasActiveVideo] = useState(false);

  return (
    <div className={`ct-app ${hasActiveVideo ? 'ct-workspace-active' : 'ct-hero-active'}`}>

      <Navbar />

      <main id="main-content" className="ct-main" tabIndex={-1}>
        <HomePage onVideoLoadStateChange={setHasActiveVideo} />
      </main>

      <footer className="ct-footer">
        <div className="ct-footer-inner">
          <p>
            © {new Date().getFullYear()} {APP_CONFIG.name}. {APP_CONFIG.tagline}
          </p>
          <p>Raslen Korbosli</p>
        </div>
      </footer>
    </div>
  );
}