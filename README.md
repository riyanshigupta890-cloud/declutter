# Declutter

**An AI that actually looks at your mess and tells you what to kill.**

Built for **BYAMN Buildathon 2026** — Theme: *Productivity Tools*

## What it does

Upload a batch of files/screenshots. Declutter classifies each one (category +
plain-language reasoning), flags likely duplicates, and lets you review
everything in a fast swipe-style UI — keep, archive, or delete — before
anything actually happens to your files.

Unlike existing duplicate-cleaner apps, Declutter tells you **why** it thinks
something is safe to let go, not just that it looks similar to another file.

## Why it's different

- **Reasoning, not just labels.** Every file gets a one-line explanation, not
  just a category tag.
- **Cross-file, not just photos.** Screenshots, PDFs, docs — not only camera
  roll duplicates.
- **Zero persistent storage.** Files are processed in-memory for
  classification only. Nothing is written to disk or a database — only the
  lightweight decision metadata (filename, category, reasoning, your choice)
  is kept for the session.
- **Human always decides.** The AI never deletes anything on its own — every
  action requires explicit confirmation, and low-confidence calls are
  flagged for extra review instead of guessed.

## Tech stack

- `client/` — React (Vite)
- `server/` — Express + Anthropic API (vision-capable classification)

## Local setup

```bash
# server
cd server
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm install
npm run dev             # http://localhost:3001

# client
cd client
npm install
npm run dev              # http://localhost:5173
```

## Limits (hackathon build)

- 10MB per file, ~50MB per session
- No account/login — single-session use
- Exact-duplicate detection via file hash; AI classification via vision LLM

## AI tools disclosed

Built with the help of Claude (Anthropic) for code scaffolding and the
classification prompt design, as required by hackathon rules.
