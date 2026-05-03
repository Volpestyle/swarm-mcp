# Phase 4 Project Spaces Manual QA

Status on 2026-04-25: automated checks and bundle refresh passed. Literal click-through could not be completed from this Codex runtime because macOS denied assistive access for `System Events` and `screencapture` failed to capture the display.

1. Open Home.
Expected: the Projects nav item is visible as a first-class Home section, and the default project root resolves to Desktop when available.

2. Click Projects, then click New Project from Desktop.
Expected: the app enters the canvas and shows a named project boundary for the Desktop root.

3. Return Home, open Projects, enter another absolute path, then click Open Project.
Expected: an existing matching project opens immediately; otherwise a project is created for that path and opened.

4. Click the project boundary label.
Expected: Project Space page opens with Overview, Agents, Notes, Roots & Assets, Tasks, and Files sections.

5. Add notes and extra roots, then click Save project context.
Expected: the project page confirms the save, and reopening the project preserves notes and roots.

6. Drag an agent node into the project boundary.
Expected: attach confirmation appears and says this shares project context without changing cwd, scope, or OS-level file permissions.

7. Confirm attach.
Expected: the agent appears in the project's Agents section and receives a project-context bootstrap containing root, extra roots, notes, current tasks, and standby/listen instructions.

8. Move or resize the project boundary so it encloses unattached agents, or click the boundary sync button.
Expected: the app offers to sync enclosed agents and does not silently change their cwd or scope.

9. In the Project Page, use Respawn in project on a stale/offline project agent.
Expected: the app asks for explicit confirmation before changing the restarted process working directory/project scope.

10. Return Home and reopen the saved project from Project Spaces.
Expected: the same project opens with the boundary and page data preserved.
