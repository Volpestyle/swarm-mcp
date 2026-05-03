# Phase 5 Assets And Multimodal Context Manual QA

Status on 2026-04-26: Slice 1 and Slice 2 are implemented, with installed-app hardening added after QA found File Bubble navigation/preview and analyzer configuration gaps. Human-visible click-through remains the final proof in `/Users/mathewfrazier/Applications/Swarm UI Lab.app`.

Test fixture folder:

- `/Users/mathewfrazier/Desktop/swarm-mcp-lab/docs/manual-qa/phase-5-fixtures`

1. Open a saved project from Home.
Expected: Project Page opens as a wide dedicated overlay, not a narrow sidebar, and shows an Assets section below Roots & Assets.

2. Click `Add image`, enter a title, image path, and description, then click `Save image`.
Expected: the asset appears under Images & Screenshots with a preview/path and description.

3. Click `Choose file` while `Add image` or `Add screenshot` is selected.
Expected: a native file picker opens with image filters, the selected image path fills the path field, and the title fills from the filename when empty. If the image cannot render, the card shows a `Preview unavailable` fallback with the path instead of a blank box.

3a. Click `Analyze image` on a saved image/screenshot asset.
Expected: if Settings > Multimodal Analyzer has a saved OpenAI key/custom command, or `OPENAI_API_KEY` / `SWARM_ASSET_ANALYZER_CMD` is configured for the app process, the button changes to `Analyzing...`, then the card shows a `Visual analysis` summary. If no analyzer is configured, the page shows a clear error pointing to Settings and the environment-variable fallback.

3aa. After a successful image analysis, inspect the project folder on disk.
Expected: `PROJECT_ROOT/workspace/README.md` exists, and `PROJECT_ROOT/workspace/YYYY-MM-DD/` contains a `visual-analysis-*.md` file with the returned AI analysis.

3b. Attach the analyzed visual asset to an agent.
Expected: the direct `[asset-context]` message includes `Visual analysis:` under the image/screenshot asset, so the agent gets practical visual context even though the terminal itself is text-only.

4. Click `Add folder`, then click `Choose folder`.
Expected: a native directory picker opens, the selected folder path fills the path field, and the title fills from the folder name when empty.

5. Click `Add note`, click `Choose file`, and select `field-notes.txt` from the fixture folder.
Expected: title/path fill in, the note content box fills with the file text, and saving shows the note preview.

5a. Click `Add note`, click `Choose file`, and select `rich-notes.rtf` from the fixture folder.
Expected: title/path fill in, the note content box fills with readable text stripped from the RTF markup.

6. Add the fixture folder path under Roots & Assets, save project context, then click `Refresh assets`.
Expected: `field-notes.txt` imports as a note, `rich-notes.rtf` imports as a note, and `mission-protocol.md` imports as a protocol without manually creating each asset. Folder Inventory shows the saved root contents; if eight or fewer items are visible, they are listed by name, otherwise they are grouped by category.

6a. Remove the fixture folder path from Roots & Assets, save project context, then click `Refresh assets`.
Expected: the page reports `No new project assets found. Scanned 1 root.` instead of silently doing nothing.

7. Try saving an image without a selected/absolute readable image path.
Expected: save is rejected with a visible validation error.

8. Try saving a note/protocol with no content and a relative or unsupported file path.
Expected: save is rejected with a visible validation error.

9. Click `Add note`, enter a title and note content, then save.
Expected: the asset appears under Notes and the preview shows text content without requiring a file path.

10. Attach an asset to an agent from the asset card.
Expected: the button changes to `Attached`, a direct `[asset-context]` message is sent to that agent when reachable, and no cwd, scope, or OS-level file permissions change.

10a. Attach an agent to a project after assets exist.
Expected: the `[project-context]` bootstrap includes a `Project assets:` section with saved asset names/paths/content summary. For analyzed visual assets, content is labeled `Visual analysis:`.

11. Select that agent and open Inspect.
Expected: Attached Assets lists the asset and shows the generated `Project assets:` context block with kind, title, path, description, and note content when present.

12. Delete an asset from the Project Page.
Expected: the asset disappears from the grid and attached-agent context; original files on disk are left untouched.

13. Quit and reopen the app, then reopen the project.
Expected: saved assets and attachments reload from SQLite.

14. Open File Bubble, click the main Encom project folder, click one folder deeper, then click Back.
Expected: the folder tile uses the Encom dark-folder image, Back returns one layer at a time, and reopening the top tile starts from the project root instead of jumping to the deepest folder.

15. In File Bubble, click an image file.
Expected: the image renders in the large preview area, clicking the image opens the fullscreen lightbox, `Expand image` also opens the lightbox, and any saved visual analysis appears below the image.

16. In File Bubble, click an mp4/mov/m4v/webm file.
Expected: the media renders as an inline video player instead of only showing raw metadata.
