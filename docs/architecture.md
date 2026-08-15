# Architecture

Dashboard -> API -> n8n -> Agent Service / Runner -> API persistence/events -> Dashboard realtime stream.

## Human-in-the-loop
Planning and execution are separate workflows. The planning workflow stops after producing a plan. The manager approves or edits the plan from the dashboard. The API then triggers the execution workflow.

## Memory
- Short-term run state: PostgreSQL `runs`, `code_versions`, `execution_results`.
- Long-term project memory: PostgreSQL `memories`.
- Live event history: Redis Stream plus durable PostgreSQL `run_events`.

## Git
Each generated project lives under `storage/projects/<project-slug>`. The API initializes Git locally. If GitHub credentials are configured, it can create/push a remote repository.
