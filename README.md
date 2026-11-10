# Pasteboard

Self-hosted personal pasteboard. Opens on a full-page live editor (synced across all open tabs/devices); a searchable archive + chat feed sits behind a button.

```sh
# Docker (builds the editor bundle in a build stage)
PASTE_PASSWORD=secret docker compose up -d      # http://localhost:3000

# or bare Node 26 LTS
npm install && npm run build
PASTE_PASSWORD=secret node server.js
```

Env: `PASTE_PASSWORD` (required), `PORT` (3000), `DATA_DIR` (./data), `MAX_UPLOAD_MB` (100).
Data = `DATA_DIR/pasteboard.db` + `DATA_DIR/files/`; back up that folder.

**Live page** (default): Tiptap + Yjs CRDT, so concurrent edits from several tabs merge. Markdown shortcuts (`# `, `- `, `[ ] `, ``` ``` ```, `**bold**`), optional toolbar (Aa), paste/drop images inline, Ctrl/⌘+click follows links, pasted plain-text markdown renders. Code blocks have a `#` button for line numbers (code/logs).
**Save** (Ctrl/⌘+S): stores the selection (or whole page) as a tagged, searchable item in the archive; "Save & clear page" empties the page (Ctrl+Z restores).
**Search & chat** (`#feed`): search, tag filter, pin, edit, quick composer, attachments. Long items clamp to ~7 lines.

curl: `curl -H "Authorization: Bearer $PASTE_PASSWORD" -H 'content-type: application/json' -d '{"text":"hi"}' host/api/items`

Use HTTPS (Caddy/nginx/Tailscale) for the clipboard Copy button and PWA install; with nginx set `proxy_buffering off` for live sync.
