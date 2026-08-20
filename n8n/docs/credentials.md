# n8n credentials

The supplied workflows use HTTP calls to internal services. No GitHub or LLM secret is embedded in workflow JSON.

Recommended:
- Keep LLM and GitHub secrets in `.env` consumed by the API/agent-service.
