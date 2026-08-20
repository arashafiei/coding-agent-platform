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

## Architecture demo

Open [`docs/system-flow.html`](docs/system-flow.html) directly in a browser for a standalone, presentation-ready explanation of:

- the complete n8n orchestration flow;
- the internal LangGraph `generate -> validate -> repair -> end` state machine;
- Planner, Coder, Reviewer, and Fixer responsibilities;
- Docker sandbox execution, persistent state, live events, retry limits, Git, and reporting;
- a suggested end-to-end presentation script.

The page is self-contained and works without starting the platform or installing dependencies:

```bash
open docs/system-flow.html        # macOS
xdg-open docs/system-flow.html    # Linux
```

Import workflow JSON files from `n8n/workflows/` or run `npm run import:n8n` after setting `N8N_API_KEY`.
