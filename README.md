# Coding Agent Platform

A JavaScript/TypeScript-first multi-agent coding platform orchestrated by n8n.

## Stack
- Next.js manager dashboard
- Node.js/Express API
- LangChain JS agent service
- PostgreSQL persistent state
- Redis Streams realtime events
- n8n orchestration
- Docker sandbox runner
- Git/GitHub version history

## Quick start
```bash
cp .env.example .env
# edit .env and set LLM + optional GitHub credentials
docker compose up -d --build
```

Open:
- Dashboard: http://localhost:3000
- API: http://localhost:4000/health
- n8n: http://localhost:5678

Import workflow JSON files from `n8n/workflows/` or run `npm run import:n8n` after setting `N8N_API_KEY`.

## Important exam defaults
`LLM_MODEL=luna-5.6-gpt` is the default to match the assignment. The architecture remains provider-agnostic through an LLM adapter.

## Local n8n already running?
You can keep your existing Docker n8n instance. Put it on `coding-agent-network` and configure the API URLs to use container DNS names, or expose the API to your existing n8n container.

See `docs/setup.md` and `docs/architecture.md`.
