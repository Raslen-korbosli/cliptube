/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        background: 'var(--bg-main, #0b0b10)',
        surface: 'var(--surface, #121318)',
        'surface-container-lowest': 'var(--surface-lowest, #090a0f)',
        'surface-container-low': 'var(--surface-low, #13141b)',
        'surface-container': 'var(--surface-container, #191a23)',
        'surface-container-high': 'var(--surface-high, #21222e)',
        'surface-container-highest': 'var(--surface-highest, #2b2c3b)',
        'on-background': 'var(--on-bg-main, #e3e1e9)',
        'on-surface': 'var(--on-surface, #e3e1e9)',
        'on-surface-variant': 'var(--on-surface-variant, #8e92a4)',
        outline: 'var(--outline, #36384a)',
        'outline-variant': 'var(--outline-variant, #242533)',
        primary: '#ff5540',
        'primary-container': '#ff4d2e',
        'on-primary-container': '#ffffff',
        secondary: '#ffb3ad',
        'secondary-container': '#c1121f',
        'on-secondary-container': '#ffffff',
        tertiary: '#22c55e',
        accent: '#ff4d2e',
        'accent-dark': '#c1121f',
        'accent-amber': '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        headline: ['Space Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        lg: '0.5rem',
        xl: '0.75rem',
        '2xl': '1rem',
        full: '9999px',
      },
    },
  },
  plugins: [],
};
