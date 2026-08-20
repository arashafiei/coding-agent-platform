# Architecture

The platform keeps n8n as its orchestration layer while the API owns durable state transitions:

`Dashboard -> API -> n8n -> LangChain agents / sandbox runner -> API persistence and events -> Dashboard`

## Workflows

Only two active n8n workflows are required:

1. **Plan** invokes the Planner and stops for human approval or textual feedback.
2. **Execute** advances Coder, Runner, Reviewer, Fixer, and Report through a single resumable workflow.

n8n controls the sequence and wait/resume behavior. It does not decide durable run state. Each stage starts through an atomic API operation, so a run cannot enter `running` unless a corresponding action execution exists.

## Agents and structured output

Planner, Coder, Reviewer, and Fixer are separate LangChain-backed roles. Their responses are validated against Zod schemas through LangChain structured-output parsing. Each invocation runs through a LangGraph state machine: `generate -> validate -> repair (when required) -> validate -> end`. One bounded correction attempt is allowed for malformed model output; network retries are disabled so the platform retry state remains the single source of truth. n8n remains responsible for orchestration between the roles, while LangGraph owns the internal decision loop of each role.

The model sent to the provider is configured exclusively through `LLM_MODEL`. For the final project it must be `gpt-5.6-luna`.

## Execution and failure recovery

Generated files are persisted as JSON code versions before they are executed in the isolated runner. The runner applies timeout and resource limits and stores stdout, stderr, and the exit code.

Every action has an attempt number, heartbeat, and terminal status. Failures move the run to `waiting_retry`; retry either resumes the registered n8n wait URL or starts a fresh n8n execution. A watchdog converts stale `running` actions into recoverable failures. The entire run has a 15-minute deadline, and Reviewer/Fixer is limited to three repair attempts. Reaching either limit creates a transparent final report and closes all non-terminal actions.

## Human-in-the-loop

Planning and execution are deliberately separate. After Planner produces a plan, the manager can approve it or submit textual feedback. Execution starts only after approval.

## State and memory

- Short-term run state: PostgreSQL `runs`, `run_actions`, `code_versions`, and `execution_results`.
- Long-term project memory: PostgreSQL `memories`.
- Live event history: Redis Stream plus durable PostgreSQL `run_events`.

## Git

Each generated project lives under `storage/projects/<project-slug>`. The API initializes Git locally. If GitHub credentials are configured, it can create and push a remote repository.
