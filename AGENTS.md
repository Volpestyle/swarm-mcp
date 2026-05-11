# Claude Guidance

## Mermaid Diagrams

- Keep Mermaid sources in `docs/diagrams/*.mmd` and rendered PNGs beside them.
- Embed PNG outputs in docs; link back to the `.mmd` source near the image.
- Render diagrams with `bun run diagrams` after changing `.mmd` files.
- Use high-resolution PNG output for stable GitHub rendering and shareable docs.
- Do not paste long Mermaid blocks directly into docs when the diagram should be maintained centrally.
- Keep source/output basenames paired, for example `backend-configuration.mmd` and `backend-configuration.png`.
