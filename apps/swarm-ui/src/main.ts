import { mount } from 'svelte';
// JetBrains Mono — vendored via @fontsource (offline-first, bundled by Vite,
// no Google Fonts CDN dependency). The Encom theme uses weights 300/400/500/
// 600/700; legacy themes use 400/500.
import '@fontsource/jetbrains-mono/300.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/jetbrains-mono/700.css';
import App from './App.svelte';
import VisualAtlas from './visual-atlas/VisualAtlas.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Failed to find #app mount point');
}

const params = new URLSearchParams(window.location.search);
const app = mount(params.get('visual-atlas') === '1' ? VisualAtlas : App, { target });

export default app;
