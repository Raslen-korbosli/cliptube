import { useState } from 'react';
import Navbar from './components/Navbar';
import HomePage from './pages/HomePage';
import { APP_CONFIG } from './config';
import './styles/trimmer.css';

export default function App() {
  // Track if a video has been loaded to toggle the modern hero vs workspace layout
  const [hasActiveVideo, setHasActiveVideo] = useState(false);

  return (
    <div className={`ct-app ${hasActiveVideo ? 'ct-workspace-active' : 'ct-hero-active'}`}>
      <Navbar />

      {/* HomePage or main container should pass or bubble up the video loading state */}
      <main className="ct-main">
        <HomePage onVideoLoadStateChange={setHasActiveVideo} />
      </main>

      <footer className="ct-footer">
        <div className="ct-footer-inner">
          <p>
            © {new Date().getFullYear()} {APP_CONFIG.name}. {APP_CONFIG.tagline}
          </p>
          <p>Clips are made with yt-dlp and ffmpeg.</p>
        </div>
      </footer>
    </div>
  );
}