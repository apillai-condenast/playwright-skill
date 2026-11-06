---
name: site-exploration
description: Explore a website using Playwright MCP and save indexed DOM, screenshot, HTML, and network evidence. Use when asked to explore or document a site's pages and navigation.
---

# Site exploration

1. Read `./base_config.yml` from the project root and get `base_url`. Ask the user if it is missing or invalid.
2. Open the browser in headless mode.
2. Use Playwright MCP to open the URL in Chromium. If Chromium is unavailable, ask the user to configure it rather than silently using another browser.
3. After each page loads, explore it using DOM/accessibility snapshots, screenshots, an HTML dump, and network traffic analysis. Use DOM snapshots to identify interactive elements.
4. Document every action that causes navigation: the action, source URL, destination URL, redirects if observed, and evidence paths. Include client-side route changes and new tabs.
5. Follow relevant same-site links and safe interactions. Ask before exploring external sites or performing destructive or state-changing actions. Record blocked or skipped areas rather than guessing.

## Progress and output

Maintain `./analysis/progress-tracker.md` throughout exploration, updating completed work, current work, pending pages, and blockers after each page or significant action. On resume, read the index and tracker first to avoid repeating work.

Organize evidence into small, independently readable files using consistent page IDs such as `001-home`:

```text
analysis/
  index.md
  progress-tracker.md
  pages/001-home.md
  dom/001-home.yaml
  screenshots/001-home.png
  html/001-home.html
  network/001-home.md
  navigation/001-home.md
```

For each distinct page or significant state:
- Save its DOM snapshot, screenshot, and HTML dump in the corresponding directories. Use a new ID for subsequent states so evidence is not overwritten.
- Analyze observed network traffic: relevant endpoints, methods, statuses, failures, and notable request/response behavior. Save a concise summary; save additional sanitized details separately only when useful. Do not persist credentials, tokens, or sensitive personal data.
- Write a short page summary covering its URL, purpose, findings, unexplored areas, and links to its evidence and navigation records.
- If an action results in a navigation, come back to the old page and continue.

Maintain `./analysis/index.md` as a compact map, not a combined evidence dump. Include directory purposes and a table of page/state IDs, URLs, short topic summaries, exploration status, and links to page summaries and evidence. Make entries descriptive enough that a reader can select relevant chunks and skip the rest. Keep detailed evidence out of the index and tracker. Record unavailable evidence explicitly.

All configuration and analysis paths above are relative to the project root, not the skill directory. Create analysis files when exploration begins; do not explore the site merely because this skill is being installed.
