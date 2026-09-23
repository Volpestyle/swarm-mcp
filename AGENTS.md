# Agent guidance

## Documentation

- `README.md` and `docs/README.md` describe the v2 coordinator on `main` in
  present tense. Do not write rollout status ("candidate", "remains open",
  "pending authorization") into reference docs; put status in Linear.
- Legacy interface docs live under `docs/legacy/` and carry a banner. Do not
  extend them; they are deleted with the legacy code under VUH-1360.
- Titles carry no Linear issue IDs. Cite the issue in a `History:` line at the
  end of the file.
- Evidence: each `docs/verification/<date>-<topic>/` keeps its README, the gate
  `manifest.json` and only the result files a document links. Raw captures go
  to CI run artifacts or stay in git history; `docs/verification/**/raw/` is
  ignored.
- Run `node scripts/check-doc-links.mjs` before committing docs; it fails on
  any relative link that does not resolve.

## Mermaid diagrams

- Keep Mermaid sources in `docs/diagrams/*.mmd` and rendered PNGs beside them.
- Embed PNG outputs in docs; link back to the `.mmd` source near the image.
- Render diagrams with `bun run diagrams` after changing `.mmd` files.
- Use high-resolution PNG output for stable GitHub rendering and shareable docs.
- Do not paste long Mermaid blocks directly into docs when the diagram should be
  maintained centrally.
- Keep source/output basenames paired, for example `backend-configuration.mmd`
  and `backend-configuration.png`.
