import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Failed to find #app mount point');
}

const app = mount(App, { target });

export default app;
