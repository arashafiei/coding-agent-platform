# Setup

1. Copy `.env.example` to `.env`.
2. Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL.
3. Optional: set GITHUB_TOKEN and GITHUB_OWNER.
4. Run `docker compose up -d --build`.
5. Open n8n and import the JSON files from `n8n/workflows/`.
6. Configure n8n HTTP nodes to call internal services by Compose names (`api`, `agent-service`, `runner`).

## Existing local Docker n8n
If you use an already-running n8n container, attach it to this network:

```bash
docker network connect coding-agent-network <your-n8n-container>
```

Then it can reach `http://api:4000`, `http://agent-service:4100`, and `http://runner:4200`.
