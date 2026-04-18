<!--
  Markdown.svelte — Render agent content as sanitized Markdown

  Uses `marked` for parsing and `DOMPurify` for sanitization. Styles live
  in this file (scoped) so the container looks native to the panel rather
  than the default GitHub/prose aesthetic.
-->
<script lang="ts">
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';

  export let content: string = '';

  marked.setOptions({
    gfm: true,
    breaks: true,
  });

  $: html = DOMPurify.sanitize(marked.parse(content, { async: false }) as string, {
    ADD_ATTR: ['target', 'rel'],
  });
</script>

<div class="md">
  {@html html}
</div>

<style>
  .md {
    font-size: 12px;
    line-height: 1.5;
    color: #cdd6f4;
    word-break: break-word;
  }

  .md :global(p) {
    margin: 0 0 8px 0;
  }

  .md :global(p:last-child) {
    margin-bottom: 0;
  }

  .md :global(strong) {
    color: var(--terminal-fg, #c0caf5);
    font-weight: 600;
  }

  .md :global(em) {
    color: #cdd6f4;
  }

  .md :global(a) {
    color: #89b4fa;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .md :global(a:hover) {
    color: #b4befe;
  }

  .md :global(h1),
  .md :global(h2),
  .md :global(h3),
  .md :global(h4),
  .md :global(h5),
  .md :global(h6) {
    margin: 10px 0 6px 0;
    font-weight: 600;
    color: var(--terminal-fg, #c0caf5);
    line-height: 1.3;
  }

  .md :global(h1) { font-size: 15px; }
  .md :global(h2) { font-size: 14px; }
  .md :global(h3) { font-size: 13px; }
  .md :global(h4),
  .md :global(h5),
  .md :global(h6) { font-size: 12px; }

  .md :global(ul),
  .md :global(ol) {
    margin: 0 0 8px 0;
    padding-left: 18px;
  }

  .md :global(li) {
    margin: 2px 0;
  }

  .md :global(li > p) {
    margin: 0;
  }

  .md :global(code) {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11.5px;
    background: rgba(137, 180, 250, 0.08);
    color: #f5c2e7;
    padding: 1px 5px;
    border-radius: 3px;
  }

  .md :global(pre) {
    background: rgba(17, 17, 27, 0.6);
    border: 1px solid var(--node-border, #313244);
    border-radius: 6px;
    padding: 8px 10px;
    margin: 8px 0;
    overflow-x: auto;
    font-size: 11.5px;
    line-height: 1.45;
  }

  .md :global(pre code) {
    background: transparent;
    color: #cdd6f4;
    padding: 0;
    border-radius: 0;
  }

  .md :global(blockquote) {
    margin: 6px 0;
    padding: 2px 10px;
    border-left: 2px solid #89b4fa;
    color: #a6adc8;
  }

  .md :global(hr) {
    border: none;
    border-top: 1px solid var(--node-border, #313244);
    margin: 10px 0;
  }

  .md :global(table) {
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 11.5px;
  }

  .md :global(th),
  .md :global(td) {
    border: 1px solid var(--node-border, #313244);
    padding: 4px 8px;
    text-align: left;
  }

  .md :global(th) {
    background: rgba(137, 180, 250, 0.06);
    font-weight: 600;
  }
</style>
