import express from 'express';
import cors from 'cors';
import pg from 'pg';
import Redis from 'ioredis';
import {simpleGit} from 'simple-git';
import {Octokit} from '@octokit/rest';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
app.use(cors());
app.use(express.json({limit: '5mb'}));
const port = Number(process.env.PORT || 4000);
const db = new pg.Pool({connectionString: process.env.DATABASE_URL});
const redis = new Redis(process.env.REDIS_URL);
const workspace = '/workspace/projects';
const systemLog = '/app/system-logs/events.log';

async function ensureSchema() {
    await db.query(`ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS request_id TEXT`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_request_id ON projects(request_id) WHERE request_id IS NOT NULL`);
    await db.query(`CREATE TABLE IF NOT EXISTS run_actions
    (
        id
        BIGSERIAL
        PRIMARY
        KEY,
        run_id
        UUID
        NOT
        NULL
        REFERENCES
        runs
                    (
        id
                    ) ON DELETE CASCADE,
        action TEXT NOT NULL,
        attempt INT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        source TEXT NOT NULL DEFAULT 'manual',
        input JSONB NOT NULL DEFAULT '{}'::jsonb,
        output JSONB NOT NULL DEFAULT '{}'::jsonb,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW
                    (
                    ),
        finished_at TIMESTAMPTZ,
        UNIQUE
                    (
                        run_id,
                        action,
                        attempt
                    )
        )`);
    await db.query(`ALTER TABLE run_actions
        ADD COLUMN IF NOT EXISTS resume_url TEXT`);
    await db.query(`ALTER TABLE run_actions
        ADD COLUMN IF NOT EXISTS n8n_execution_id TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_run_actions_run_action ON run_actions(run_id, action, attempt DESC)`);

    // Clean up orphaned attempts created by the older retry implementation.
    // If a newer attempt exists for the same run/action, an older "running"
    // row cannot still be the active attempt.
    await db.query(`
        UPDATE run_actions AS current
        SET status = 'failed',
            error = COALESCE(current.error, 'Superseded by a newer attempt'),
            finished_at = COALESCE(current.finished_at, NOW())
        WHERE current.status = 'running'
          AND EXISTS (
              SELECT 1
              FROM run_actions AS newer
              WHERE newer.run_id = current.run_id
                AND newer.action = current.action
                AND newer.attempt > current.attempt
          )
    `);
}


const slugify = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function event(runId, projectId, source, type, message, data = {}) {
    const payload = {runId, projectId, source, type, message, data, ts: new Date().toISOString()};
    await db.query(
        'INSERT INTO run_events(project_id,run_id,source,type,message,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [projectId, runId, source, type, message, JSON.stringify(data ?? {})]
    );
    await redis.xadd(`run:${runId}:events`, '*', 'payload', JSON.stringify(payload));
    await fs.mkdir(path.dirname(systemLog), {recursive: true});
    await fs.appendFile(systemLog, JSON.stringify(payload) + '\n');
}

async function trigger(pathname, body) {
    const url = `${process.env.N8N_INTERNAL_URL || 'http://n8n:5678'}/webhook/${pathname}`;
    const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`n8n ${r.status}: ${await r.text()}`);
    return r.json().catch(() => ({ok: true}));
}

async function ensureLocalGitRepo(dir) {
    await fs.mkdir(dir, {recursive: true});

    const git = simpleGit(dir);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
        await git.init();
        await git.addConfig('user.name', 'Coding Agent');
        await git.addConfig('user.email', 'coding-agent@local');

        try {
            await fs.access(path.join(dir, '.gitignore'));
        } catch {
            await fs.writeFile(path.join(dir, '.gitignore'), 'node_modules\n.env\ndist\n');
        }

        await git.branch(['-M', 'main']).catch(() => {
        });
    }

    return git;
}

async function ensureRepo(project) {
    const dir = path.join(workspace, project.slug);
    const git = await ensureLocalGitRepo(dir);

    await git.add('.');
    try {
        await git.commit('chore: initialize generated project');
    } catch {
        // An empty repository is valid here.
    }

    if (process.env.GITHUB_AUTO_CREATE_REPO === 'true' && process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && !project.github_repo) {
        const octokit = new Octokit({auth: process.env.GITHUB_TOKEN});
        const name = project.slug;
        await octokit.repos.createForAuthenticatedUser({name, private: process.env.GITHUB_DEFAULT_PRIVATE !== 'false'});
        const url = `https://github.com/${process.env.GITHUB_OWNER}/${name}.git`;
        await git.addRemote('origin', url).catch(() => {
        });
        await db.query(
            'UPDATE projects SET github_repo=$1,github_url=$2 WHERE id=$3',
            [`${process.env.GITHUB_OWNER}/${name}`, url.replace('.git', ''), project.id]
        );
    }

    return dir;
}


async function postJson(url, body) {
    const r = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${url} returned ${r.status}`);
    return data;
}

async function startAction(run, action, input = {}, source = 'workflow') {
    // A stage may be bootstrapped again after an old/legacy execution failed.
    // Close orphaned state before creating the next authoritative attempt.
    await db.query(
        `UPDATE run_actions
         SET status = CASE
                 WHEN status = 'retry_requested' THEN 'retried'
                 ELSE 'failed'
             END,
             error = CASE
                 WHEN status = 'running'
                     THEN COALESCE(error, 'Superseded by a newer attempt')
                 ELSE error
             END,
             finished_at = COALESCE(finished_at, NOW())
         WHERE run_id=$1
           AND action=$2
           AND status IN ('running','retry_requested')`,
        [run.id, action]
    );

    const attempt = Number((await db.query(
        'SELECT COALESCE(MAX(attempt),0)+1 attempt FROM run_actions WHERE run_id=$1 AND action=$2',
        [run.id, action]
    )).rows[0].attempt);

    const row = (await db.query(
        `INSERT INTO run_actions(run_id, action, attempt, status, source, input)
         VALUES ($1, $2, $3, 'running', $4, $5::jsonb) RETURNING *`,
        [run.id, action, attempt, source, JSON.stringify(input ?? {})]
    )).rows[0];

    await event(
        run.id,
        run.project_id,
        action,
        'ACTION_STARTED',
        `${action} attempt #${attempt} started`,
        {action, attempt, source}
    );

    return row;
}

async function finishAction(actionRow, status, output = {}, error = null) {
    return (await db.query(
        `UPDATE run_actions
         SET status=$1,
             output=$2::jsonb,error=$3, finished_at=NOW()
         WHERE id=$4
             RETURNING *`,
        [status, JSON.stringify(output ?? {}), error, actionRow.id]
    )).rows[0];
}

async function finishLatestRunningAction(runId, action, status, output = {}, error = null) {
    const row = (await db.query(
        "SELECT * FROM run_actions WHERE run_id=$1 AND action=$2 AND status='running' ORDER BY attempt DESC LIMIT 1",
        [runId, action]
    )).rows[0];

    if (row) {
        await finishAction(row, status, output, error);
    }
}

async function writeFilesForRun(run, files = [], agent = 'coder', attempt = 0, message) {
    const dir = path.join(workspace, run.slug);
    await fs.mkdir(dir, {recursive: true});
    for (const f of files) {
        const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
        const full = path.join(dir, safe);
        if (!full.startsWith(dir)) throw new Error('Unsafe path');
        await fs.mkdir(path.dirname(full), {recursive: true});
        await fs.writeFile(full, f.content);
    }
    const git = await ensureLocalGitRepo(dir);
    await git.add('.');
    let sha = null;
    try {
        await git.commit(message || `agent: update run ${run.id}`);
        sha = (await git.revparse(['HEAD'])).trim();
    } catch {
    }
    if (sha && run.github_repo && process.env.GITHUB_TOKEN) {
        const remote = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${run.github_repo}.git`;
        await git.push(remote, 'HEAD:main', ['--force-with-lease']).catch(() => git.push(remote, 'HEAD:main').catch(() => {
        }));
    }
    await db.query(
        'INSERT INTO code_versions(run_id,agent,attempt,files,commit_sha) VALUES($1,$2,$3,$4::jsonb,$5)',
        [run.id, agent, attempt, JSON.stringify(files ?? []), sha]
    );
    await event(run.id, run.project_id, agent, 'FILES_WRITTEN', `${files.length} files written`, {
        commitSha: sha,
        attempt
    });
    return {ok: true, commitSha: sha};
}

app.get('/health', (_q, r) => r.json({ok: true}));
app.get('/projects', async (req, res) => {
    const status = req.query.status;
    const query = status && status !== 'all'
        ? ['SELECT * FROM projects WHERE status=$1 ORDER BY created_at DESC', [status]]
        : ['SELECT * FROM projects ORDER BY created_at DESC', []];
    res.json((await db.query(query[0], query[1])).rows);
});
app.post('/projects', async (req, res) => {
    try {
        const {name, description = '', requirements, requestId} = req.body;
        if (!name?.trim() || !requirements?.trim()) return res.status(400).json({error: 'name and requirements are required'});
        if (requestId) {
            const existing = (await db.query('SELECT * FROM projects WHERE request_id=$1', [requestId])).rows[0];
            if (existing) {
                const run = (await db.query('SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at ASC LIMIT 1', [existing.id])).rows[0];
                return res.status(200).json({project: existing, run, idempotent: true});
            }
        }
        const slug = `${slugify(name)}-${Date.now().toString(36)}`;
        let p;
        try {
            p = (await db.query('INSERT INTO projects(name,slug,description,requirements,request_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [name.trim(), slug, description, requirements, requestId || null])).rows[0];
        } catch (e) {
            if (e.code === '23505' && requestId) {
                const existing = (await db.query('SELECT * FROM projects WHERE request_id=$1', [requestId])).rows[0];
                const run = (await db.query('SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at ASC LIMIT 1', [existing.id])).rows[0];
                return res.status(200).json({project: existing, run, idempotent: true});
            }
            throw e;
        }
        await ensureRepo(p);
        const run = (await db.query("INSERT INTO runs(project_id,request,status,current_stage) VALUES($1,$2,'planning','planner') RETURNING *", [p.id, requirements])).rows[0];
        await event(run.id, p.id, 'api', 'RUN_CREATED', 'Project and initial run created');
        await trigger('coding-agent-plan', {projectId: p.id, runId: run.id, request: requirements});
        res.status(201).json({project: p, run});
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});
app.get('/projects/:id', async (req, res) => {
    const p = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
    if (!p) return res.sendStatus(404);
    const runs = (await db.query('SELECT * FROM runs WHERE project_id=$1 ORDER BY created_at DESC', [p.id])).rows;
    res.json({...p, runs});
});
app.patch('/projects/:id', async (req, res) => {
    try {
        const current = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
        if (!current) return res.sendStatus(404);
        const name = req.body.name?.trim() || current.name;
        const description = req.body.description ?? current.description;
        const requirements = req.body.requirements ?? current.requirements;
        const p = (await db.query('UPDATE projects SET name=$1,description=$2,requirements=$3,updated_at=NOW() WHERE id=$4 RETURNING *', [name, description, requirements, current.id])).rows[0];
        res.json(p);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});
app.post('/projects/:id/archive', async (req, res) => {
    const p = (await db.query("UPDATE projects SET status='archived',updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id])).rows[0];
    if (!p) return res.sendStatus(404);
    res.json(p);
});
app.post('/projects/:id/restore', async (req, res) => {
    const p = (await db.query("UPDATE projects SET status='active',updated_at=NOW() WHERE id=$1 RETURNING *", [req.params.id])).rows[0];
    if (!p) return res.sendStatus(404);
    res.json(p);
});
app.delete('/projects/:id', async (req, res) => {
    try {
        const p = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
        if (!p) return res.sendStatus(404);
        await db.query('DELETE FROM projects WHERE id=$1', [p.id]);
        await fs.rm(path.join(workspace, p.slug), {recursive: true, force: true});
        res.json({ok: true, id: p.id});
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});
app.post('/projects/:id/changes', async (req, res) => {
    try {
        const p = (await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id])).rows[0];
        if (!p) return res.sendStatus(404);
        if (p.status === 'archived') return res.status(409).json({error: 'Restore the project before starting a new change'});
        const run = (await db.query("INSERT INTO runs(project_id,type,request,status,current_stage) VALUES($1,'CHANGE_REQUEST',$2,'planning','planner') RETURNING *", [p.id, req.body.request])).rows[0];
        await event(run.id, p.id, 'api', 'RUN_CREATED', 'Change request created');
        await trigger('coding-agent-plan', {projectId: p.id, runId: run.id, request: req.body.request});
        res.status(201).json(run);
    } catch (e) {
        res.status(500).json({error: e.message})
    }
});
app.get('/runs/:id', async (req, res) => {
    const run = (await db.query(
        'SELECT r.*,p.name project_name,p.slug,p.github_repo,p.status project_status FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.id=$1',
        [req.params.id]
    )).rows[0];
    if (!run) return res.sendStatus(404);
    const events = (await db.query('SELECT * FROM run_events WHERE run_id=$1 ORDER BY id', [run.id])).rows;
    const actions = (await db.query(
        `SELECT id,
                run_id, action, attempt, status, source, input, output, error, started_at, finished_at, n8n_execution_id
         FROM run_actions
         WHERE run_id=$1
         ORDER BY id`,
        [run.id]
    )).rows;
    res.json({...run, events, actions});
});

function normalizeResumeUrl(resumeUrl) {
    if (!resumeUrl) return null;

    return resumeUrl
        .replace('http://localhost:5678', 'http://n8n:5678')
        .replace('http://127.0.0.1:5678', 'http://n8n:5678');
}

async function getRunForStage(runId) {
    return (await db.query(
        `SELECT r.*, p.slug, p.github_repo, p.status project_status
         FROM runs r
                  JOIN projects p ON p.id = r.project_id
         WHERE r.id = $1`,
        [runId]
    )).rows[0];
}

async function executeStage(run, action) {
    const allowed = ['planner', 'coder', 'runner', 'reviewer', 'fixer', 'git', 'report'];
    if (!allowed.includes(action)) {
        throw new Error(`Unsupported stage: ${action}`);
    }

    const actionRow = await startAction(run, action, {currentStage: run.current_stage}, 'workflow');

    try {
        let output = {};
        let nextStage = action;
        let nextStatus = 'running';
        let shouldContinue = true;

        if (action === 'planner') {
            output = await postJson('http://agent-service:4100/planner', {
                projectId: run.project_id,
                runId: run.id,
                request: run.request
            });

            await db.query(
                `UPDATE runs
                 SET plan=$1::jsonb,status='awaiting_approval',current_stage='human_approval',finished_at=NULL
                 WHERE id=$2`,
                [JSON.stringify(output ?? {}), run.id]
            );

            await event(
                run.id,
                run.project_id,
                'planner',
                'PLAN_READY',
                'Plan ready for manager approval',
                output
            );

            nextStage = 'human_approval';
            nextStatus = 'awaiting_approval';
            shouldContinue = false;
        } else if (action === 'coder') {
            if (!run.plan) throw new Error('Coder requires an approved planner output');

            output = await postJson('http://agent-service:4100/coder', {
                request: run.request,
                plan: run.plan,
                humanFeedback: run.human_feedback
            });

            await writeFilesForRun(
                run,
                Array.isArray(output.files) ? output.files : [],
                'coder',
                actionRow.attempt,
                `feat: coder attempt ${actionRow.attempt}`
            );

            nextStage = 'runner';
        } else if (action === 'runner') {
            const dir = path.join(workspace, run.slug);
            await fs.access(path.join(dir, 'package.json'));

            output = await postJson('http://runner:4200/execute', {
                projectSlug: run.slug,
                command: 'npm test'
            });

            await db.query(
                `INSERT INTO execution_results(run_id, attempt, command, exit_code, stdout, stderr, duration_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    run.id,
                    actionRow.attempt,
                    'npm test',
                    output.exitCode,
                    output.stdout || '',
                    output.stderr || '',
                    output.durationMs
                ]
            );

            await event(
                run.id,
                run.project_id,
                'runner',
                output.exitCode === 0 ? 'EXECUTION_PASSED' : 'EXECUTION_FAILED',
                `Execution finished with code ${output.exitCode}`,
                {...output, attempt: actionRow.attempt}
            );

            // A failing test command is still a successful Runner action:
            // Reviewer decides whether Fixer is needed.
            nextStage = 'reviewer';
        } else if (action === 'reviewer') {
            const execution = (await db.query(
                'SELECT * FROM execution_results WHERE run_id=$1 ORDER BY id DESC LIMIT 1',
                [run.id]
            )).rows[0];

            if (!execution) throw new Error('Reviewer requires a previous Runner execution');

            output = await postJson('http://agent-service:4100/reviewer', {
                request: run.request,
                plan: run.plan,
                execution: {
                    exitCode: execution.exit_code,
                    stdout: execution.stdout,
                    stderr: execution.stderr,
                    durationMs: execution.duration_ms
                },
                attempt: actionRow.attempt
            });

            nextStage = output.passed ? 'report' : 'fixer';

            await event(
                run.id,
                run.project_id,
                'reviewer',
                output.passed ? 'REVIEW_PASSED' : 'REVIEW_FAILED',
                output.reason || 'Review completed',
                {...output, attempt: actionRow.attempt}
            );
        } else if (action === 'fixer') {
            const maxFixAttempts = Number(process.env.MAX_FIX_ATTEMPTS || 3);
            if (run.fix_attempt >= maxFixAttempts) {
                throw new Error(`Fixer retry limit exceeded (${maxFixAttempts})`);
            }

            const execution = (await db.query(
                'SELECT * FROM execution_results WHERE run_id=$1 ORDER BY id DESC LIMIT 1',
                [run.id]
            )).rows[0];

            if (!execution) throw new Error('Fixer requires a previous Runner execution');

            const latestFiles = (await db.query(
                'SELECT files FROM code_versions WHERE run_id=$1 ORDER BY id DESC LIMIT 1',
                [run.id]
            )).rows[0]?.files || [];

            output = await postJson('http://agent-service:4100/fixer', {
                request: run.request,
                plan: run.plan,
                execution: {
                    exitCode: execution.exit_code,
                    stdout: execution.stdout,
                    stderr: execution.stderr
                },
                currentFiles: latestFiles,
                previousAttempts: run.fix_attempt,
                attempt: run.fix_attempt + 1
            });

            const fixAttempt = run.fix_attempt + 1;

            await writeFilesForRun(
                run,
                Array.isArray(output.files) ? output.files : [],
                'fixer',
                fixAttempt,
                `fix: repair attempt ${fixAttempt}`
            );

            await db.query(
                'UPDATE runs SET fix_attempt=$1 WHERE id=$2',
                [fixAttempt, run.id]
            );

            nextStage = 'runner';
        } else if (action === 'git') {
            const dir = path.join(workspace, run.slug);
            const git = await ensureLocalGitRepo(dir);

            await git.add('.');
            try {
                await git.commit(`chore: git stage for run ${run.id}`);
            } catch {
                // Nothing to commit.
            }

            const sha = (await git.revparse(['HEAD'])).trim();

            if (run.github_repo && process.env.GITHUB_TOKEN) {
                const remote = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${run.github_repo}.git`;
                await git.push(remote, 'HEAD:main', ['--force-with-lease']).catch(() =>
                    git.push(remote, 'HEAD:main')
                );
            }

            output = {
                commitSha: sha,
                pushed: Boolean(run.github_repo && process.env.GITHUB_TOKEN)
            };
            nextStage = 'report';
        } else if (action === 'report') {
            const execution = (await db.query(
                'SELECT * FROM execution_results WHERE run_id=$1 ORDER BY id DESC LIMIT 1',
                [run.id]
            )).rows[0];

            const passed = execution?.exit_code === 0;

            const report = `# Coding Agent Run Report

## Request
${run.request}

## Plan
${JSON.stringify(run.plan ?? {}, null, 2)}

## Execution
${execution ? `Exit code: ${execution.exit_code}

stdout:
${execution.stdout}

stderr:
${execution.stderr}` : 'No execution result is available.'}

## Result
${passed ? 'Succeeded' : 'Needs attention'}
`;

            output = {report, passed};
            nextStage = 'report';
            nextStatus = passed ? 'succeeded' : 'failed';
            shouldContinue = false;

            await db.query(
                `UPDATE runs
                 SET final_report=$1,
                     status=$2,
                     current_stage='report',
                     finished_at=NOW()
                 WHERE id = $3`,
                [report, nextStatus, run.id]
            );

            await event(
                run.id,
                run.project_id,
                'report',
                'REPORT_GENERATED',
                'Final report generated',
                {passed}
            );
        }

        await finishAction(actionRow, 'succeeded', output);

        if (action !== 'planner' && action !== 'report') {
            await db.query(
                `UPDATE runs
                 SET status=$1,
                     current_stage=$2,
                     finished_at=NULL
                 WHERE id = $3`,
                [nextStatus, nextStage, run.id]
            );
        }

        await event(
            run.id,
            run.project_id,
            action,
            'ACTION_COMPLETED',
            `${action} attempt #${actionRow.attempt} completed`,
            {
                action,
                attempt: actionRow.attempt,
                nextStage,
                nextStatus
            }
        );

        return {
            ok: true,
            action,
            attempt: actionRow.attempt,
            output,
            nextStage,
            status: nextStatus,
            continue: shouldContinue
        };
    } catch (error) {
        await finishAction(actionRow, 'failed', {}, error.message).catch(() => {
        });

        await db.query(
            `UPDATE runs
             SET status='waiting_retry',
                 current_stage=$1,
                 finished_at=NULL
             WHERE id = $2`,
            [action, run.id]
        ).catch(() => {
        });

        await event(
            run.id,
            run.project_id,
            action,
            'ACTION_FAILED',
            `${action} attempt #${actionRow.attempt} failed`,
            {
                action,
                attempt: actionRow.attempt,
                error: error.message
            }
        ).catch(() => {
        });

        return {
            ok: false,
            action,
            attempt: actionRow.attempt,
            error: error.message,
            continue: false
        };
    }
}

app.post('/runs/:id/stages/planner/execute', async (req, res) => {
    const run = await getRunForStage(req.params.id);
    if (!run) return res.sendStatus(404);
    if (run.project_status === 'archived') {
        return res.status(409).json({error: 'Restore the project before continuing'});
    }

    res.json(await executeStage(run, 'planner'));
});

app.post('/runs/:id/stages/current/execute', async (req, res) => {
    const run = await getRunForStage(req.params.id);
    if (!run) return res.sendStatus(404);
    if (run.project_status === 'archived') {
        return res.status(409).json({error: 'Restore the project before continuing'});
    }

    const action = run.current_stage;
    if (action === 'human_approval') {
        return res.status(409).json({
            error: 'Run is waiting for human approval',
            action
        });
    }

    res.json(await executeStage(run, action));
});

app.post('/runs/:id/actions/:action/wait', async (req, res) => {
    const {action} = req.params;
    const run = await getRunForStage(req.params.id);
    if (!run) return res.sendStatus(404);

    if (run.current_stage !== action) {
        return res.status(409).json({
            error: `Current stage changed to ${run.current_stage}; refusing to register a stale retry wait`
        });
    }

    const resumeUrl = normalizeResumeUrl(req.body?.resumeUrl);
    if (!resumeUrl) {
        return res.status(400).json({error: 'resumeUrl is required'});
    }

    const actionRow = (await db.query(
        `SELECT *
         FROM run_actions
         WHERE run_id = $1
           AND action =$2
           AND status='failed'
         ORDER BY attempt DESC
             LIMIT 1`,
        [run.id, action]
    )).rows[0];

    if (!actionRow) {
        return res.status(409).json({
            error: 'No failed action attempt is available to wait for retry',
            action
        });
    }

    await db.query(
        `UPDATE run_actions
         SET status='waiting_retry',
             resume_url=$1,
             n8n_execution_id=$2,
             error=COALESCE($3, error)
         WHERE id = $4`,
        [
            resumeUrl,
            req.body?.executionId ? String(req.body.executionId) : null,
            req.body?.error || null,
            actionRow.id
        ]
    );

    await db.query(
        `UPDATE runs
         SET status='waiting_retry',
             current_stage=$1,
             finished_at=NULL
         WHERE id = $2`,
        [action, run.id]
    );

    await event(
        run.id,
        run.project_id,
        'n8n',
        'ACTION_WAITING_FOR_RETRY',
        `${action} is waiting for manager retry`,
        {
            action,
            attempt: actionRow.attempt,
            n8nExecutionId: req.body?.executionId || null
        }
    );

    res.json({
        ok: true,
        action,
        attempt: actionRow.attempt,
        waiting: true
    });
});

app.post('/runs/:id/actions/:action/retry', async (req, res) => {
    const allowed = ['planner', 'coder', 'runner', 'reviewer', 'fixer', 'git', 'report'];
    const action = req.params.action;

    if (!allowed.includes(action)) {
        return res.status(400).json({error: `Unknown retry action: ${action}`});
    }

    const run = await getRunForStage(req.params.id);
    if (!run) return res.sendStatus(404);

    if (run.project_status === 'archived') {
        return res.status(409).json({error: 'Restore the project before retrying an action'});
    }

    if (run.current_stage !== action) {
        return res.status(409).json({
            error: `Only the current stage can be retried. Current stage: ${run.current_stage}`
        });
    }

    if (run.status !== 'waiting_retry' && run.status !== 'failed') {
        return res.status(409).json({
            error: `Current stage is not waiting for retry. Current status: ${run.status}`
        });
    }

    const actionRow = (await db.query(
        `SELECT *
         FROM run_actions
         WHERE run_id = $1
           AND action =$2
           AND status='waiting_retry'
           AND resume_url IS NOT NULL
         ORDER BY attempt DESC
             LIMIT 1`,
        [run.id, action]
    )).rows[0];

    // Runs that failed before same-execution retry was introduced do not have a
    // resume URL. They still need to be retryable, so dispatch the current stage
    // through a fresh workflow execution instead of leaving the run stranded.
    if (!actionRow) {
        const previousStatus = run.status;

        await db.query(
            `UPDATE runs
             SET status='running',
                 finished_at=NULL
             WHERE id=$1`,
            [run.id]
        );

        await event(
            run.id,
            run.project_id,
            'human',
            'ACTION_RETRY_REQUESTED',
            `Manager requested a fresh retry for ${action}`,
            {action, mode: 'fresh_execution'}
        );

        try {
            const workflow = action === 'planner'
                ? 'coding-agent-plan'
                : 'coding-agent-execute';

            await trigger(workflow, {
                runId: run.id,
                projectId: run.project_id,
                retry: true,
                action
            });

            await event(
                run.id,
                run.project_id,
                'api',
                'ACTION_RETRY_DISPATCHED',
                `${action} retry dispatched in a fresh n8n execution`,
                {action, mode: 'fresh_execution', workflow}
            );

            return res.json({
                ok: true,
                action,
                resumed: false,
                dispatched: true,
                mode: 'fresh_execution'
            });
        } catch (error) {
            await db.query(
                `UPDATE runs
                 SET status=$1
                 WHERE id=$2`,
                [previousStatus, run.id]
            ).catch(() => {
            });

            await event(
                run.id,
                run.project_id,
                'api',
                'ACTION_RETRY_DISPATCH_FAILED',
                `Could not dispatch a fresh ${action} retry`,
                {action, error: error.message}
            ).catch(() => {
            });

            return res.status(502).json({
                error: error.message,
                action
            });
        }
    }

    await db.query(
        `UPDATE run_actions
         SET status='retry_requested'
         WHERE id = $1`,
        [actionRow.id]
    );

    await db.query(
        `UPDATE runs
         SET status='running',
             finished_at=NULL
         WHERE id = $1`,
        [run.id]
    );

    await event(
        run.id,
        run.project_id,
        'human',
        'ACTION_RETRY_REQUESTED',
        `Manager resumed ${action} after attempt #${actionRow.attempt}`,
        {
            action,
            previousAttempt: actionRow.attempt,
            n8nExecutionId: actionRow.n8n_execution_id
        }
    );

    try {
        const response = await fetch(actionRow.resume_url, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                retry: true,
                action,
                previousAttempt: actionRow.attempt
            })
        });

        if (!response.ok) {
            throw new Error(`n8n resume ${response.status}: ${await response.text()}`);
        }

        await event(
            run.id,
            run.project_id,
            'api',
            'ACTION_RETRY_RESUMED',
            `${action} resumed in the same n8n execution`,
            {
                action,
                previousAttempt: actionRow.attempt,
                n8nExecutionId: actionRow.n8n_execution_id
            }
        );

        res.json({
            ok: true,
            action,
            resumed: true,
            n8nExecutionId: actionRow.n8n_execution_id
        });
    } catch (error) {
        await db.query(
            `UPDATE run_actions
             SET status='waiting_retry'
             WHERE id = $1`,
            [actionRow.id]
        ).catch(() => {
        });

        await db.query(
            `UPDATE runs
             SET status='waiting_retry'
             WHERE id = $1`,
            [run.id]
        ).catch(() => {
        });

        await event(
            run.id,
            run.project_id,
            'api',
            'ACTION_RETRY_RESUME_FAILED',
            `Could not resume ${action} in n8n`,
            {action, error: error.message}
        ).catch(() => {
        });

        res.status(502).json({
            error: error.message,
            action
        });
    }
});

app.post('/runs/:id/plan', async (req, res) => {
    const run = (await db.query(
        'UPDATE runs SET plan=$1::jsonb,status=$2,current_stage=$3,finished_at=NULL WHERE id=$4 RETURNING *',
        [JSON.stringify(req.body.plan ?? {}), 'awaiting_approval', 'human_approval', req.params.id]
    )).rows[0];
    await finishLatestRunningAction(run.id, 'planner', 'succeeded', req.body.plan).catch(() => {
    });
    await event(run.id, run.project_id, 'planner', 'PLAN_READY', 'Plan ready for manager approval', req.body.plan);
    res.json(run);
});
app.post('/runs/:id/approve', async (req, res) => {
    try {
        const run = (await db.query("UPDATE runs SET human_feedback=human_feedback || $1::jsonb,status='running',current_stage='coder',started_at=COALESCE(started_at,NOW()) WHERE id=$2 RETURNING *", [JSON.stringify(req.body.feedback ? [{
            message: req.body.feedback,
            at: new Date().toISOString()
        }] : []), req.params.id])).rows[0];
        await event(run.id, run.project_id, 'human', 'HUMAN_APPROVED', 'Manager approved plan', {feedback: req.body.feedback || ''});
        await trigger('coding-agent-execute', {runId: run.id, projectId: run.project_id});
        res.json(run);
    } catch (e) {
        res.status(500).json({error: e.message})
    }
});
app.post('/runs/:id/state', async (req, res) => {
    const {status, currentStage, fixAttempt, finalReport} = req.body;
    const run = (await db.query('UPDATE runs SET status=COALESCE($1,status),current_stage=COALESCE($2,current_stage),fix_attempt=COALESCE($3,fix_attempt),final_report=COALESCE($4,final_report),finished_at=CASE WHEN $1 IN (\'succeeded\',\'failed\',\'cancelled\') THEN NOW() ELSE finished_at END WHERE id=$5 RETURNING *', [status, currentStage, fixAttempt, finalReport, req.params.id])).rows[0];
    if (req.body.event) await event(run.id, run.project_id, req.body.event.source || 'system', req.body.event.type, req.body.event.message, req.body.event.data || {});
    res.json(run);
});
app.post('/runs/:id/files', async (req, res) => {
    try {
        const run = (await db.query(
            `SELECT r.*,
                    p.slug,
                    p.github_repo
             FROM runs r
                      JOIN projects p ON p.id = r.project_id
             WHERE r.id = $1`,
            [req.params.id]
        )).rows[0];

        if (!run) {
            return res.status(404).json({error: 'Run not found'});
        }

        const dir = path.join(workspace, run.slug);
        await fs.mkdir(dir, {recursive: true});

        // Be defensive here: generated-project storage may survive independently
        // from Git metadata, or an older project may not have been initialized.
        const git = simpleGit(dir);
        const isRepo = await git.checkIsRepo();

        if (!isRepo) {
            await git.init();
            await git.addConfig('user.name', 'Coding Agent');
            await git.addConfig('user.email', 'coding-agent@local');

            const gitignore = path.join(dir, '.gitignore');
            try {
                await fs.access(gitignore);
            } catch {
                await fs.writeFile(gitignore, 'node_modules\n.env\ndist\n');
            }

            await event(
                run.id,
                run.project_id,
                'git',
                'GIT_REPOSITORY_INITIALIZED',
                'Local Git repository initialized'
            );
        }

        for (const f of req.body.files || []) {
            const safe = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, '');
            const full = path.join(dir, safe);
            if (!full.startsWith(dir)) throw new Error('Unsafe path');
            await fs.mkdir(path.dirname(full), {recursive: true});
            await fs.writeFile(full, f.content);
        }

        await git.add('.');

        const msg = req.body.message || `agent: update run ${run.id}`;
        let sha = null;

        try {
            await git.commit(msg);
            sha = (await git.revparse(['HEAD'])).trim();
        } catch {
            // No changes to commit is not a fatal error for the pipeline.
        }

        if (sha && run.github_repo && process.env.GITHUB_TOKEN) {
            const remote = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${run.github_repo}.git`;
            await git.push(remote, 'HEAD:main', ['--force-with-lease']).catch(() =>
                git.push(remote, 'HEAD:main').catch(() => {
                })
            );
        }

        await db.query(
            'INSERT INTO code_versions(run_id,agent,attempt,files,commit_sha) VALUES($1,$2,$3,$4::jsonb,$5)',
            [
                run.id,
                req.body.agent || 'coder',
                req.body.attempt || 0,
                JSON.stringify(req.body.files || []),
                sha
            ]
        );

        await event(
            run.id,
            run.project_id,
            req.body.agent || 'coder',
            'FILES_WRITTEN',
            `${(req.body.files || []).length} files written`,
            {commitSha: sha}
        );

        res.json({ok: true, commitSha: sha});
    } catch (e) {
        res.status(500).json({error: e.message})
    }
});
app.post('/runs/:id/execution', async (req, res) => {
    const run = (await db.query('SELECT * FROM runs WHERE id=$1', [req.params.id])).rows[0];
    await db.query('INSERT INTO execution_results(run_id,attempt,command,exit_code,stdout,stderr,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)', [run.id, req.body.attempt || 0, req.body.command || '', req.body.exitCode, req.body.stdout || '', req.body.stderr || '', req.body.durationMs]);
    await event(run.id, run.project_id, 'runner', req.body.exitCode === 0 ? 'EXECUTION_PASSED' : 'EXECUTION_FAILED', `Execution finished with code ${req.body.exitCode}`, req.body);
    res.json({ok: true});
});
app.get('/runs/:id/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    let last = '$';
    const key = `run:${req.params.id}:events`;
    const loop = async () => {
        while (!res.writableEnded) {
            try {
                const out = await redis.xread('BLOCK', 15000, 'COUNT', 50, 'STREAMS', key, last);
                if (!out) {
                    res.write(': ping\n\n');
                    continue;
                }
                for (const [, items] of out) for (const [id, fields] of items) {
                    last = id;
                    const i = fields.indexOf('payload');
                    if (i >= 0) res.write(`data: ${fields[i + 1]}\n\n`);
                }
            } catch {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    };
    loop();
});
ensureSchema()
    .then(() => app.listen(port, '0.0.0.0', () => console.log(`api listening ${port}`)))
    .catch(err => {
        console.error('database bootstrap failed', err);
        process.exit(1);
    });
