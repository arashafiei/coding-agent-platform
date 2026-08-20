import express from 'express';
import {z} from 'zod';
import {StructuredOutputParser} from '@langchain/core/output_parsers';
import {Annotation, END, START, StateGraph} from '@langchain/langgraph';
import {jsonrepair} from 'jsonrepair';
import {createLLM, getLLMConfig} from '../../../packages/llm/src/index.js';

const app = express();
app.use(express.json({limit: '2mb'}));
const port = Number(process.env.PORT || 4100);

const fileSchema = z.object({
    path: z.string().min(1),
    content: z.string()
});

const plannerSchema = z.object({
    summary: z.string(),
    clarificationNeeded: z.boolean().default(false),
    clarificationQuestions: z.array(z.string()).default([]),
    steps: z.array(z.object({
        title: z.string(),
        description: z.string(),
        files: z.array(z.string()).default([]),
        commands: z.array(z.string()).default([])
    })).min(1)
});

const coderSchema = z.object({
    summary: z.string(),
    files: z.array(fileSchema).min(1),
    installCommand: z.string().default('npm install'),
    testCommand: z.string().default('npm test'),
    runCommand: z.string().default('npm start')
});

const reviewerSchema = z.object({
    passed: z.boolean(),
    reason: z.string(),
    recommendedFixes: z.array(z.string()).default([])
});

const fixerSchema = z.object({
    summary: z.string(),
    files: z.array(fileSchema).min(1),
    testCommand: z.string().default('npm test')
});

async function invokeStructured(system, payload, schema, name, options = {}) {
    const llm = createLLM(options);
    const parser = StructuredOutputParser.fromZodSchema(schema);
    const formatInstructions = parser.getFormatInstructions();
    const messages = [
        {role: 'system', content: `${system}\n${formatInstructions}\nReturn only the requested JSON object.`},
        {role: 'user', content: JSON.stringify(payload, null, 2)}
    ];
    const AgentState = Annotation.Root({
        messages: Annotation(),
        response: Annotation(),
        result: Annotation(),
        parseError: Annotation(),
        repaired: Annotation({default: () => false})
    });

    const graph = new StateGraph(AgentState)
        .addNode('generate', async state => {
            const response = await llm.invoke(state.messages);
            return {response: String(response.content)};
        })
        .addNode('validate', async state => {
            try {
                return {result: await parser.parse(state.response), parseError: null};
            } catch (error) {
                try {
                    const unfenced = state.response
                        .replace(/^\s*```(?:json)?\s*/i, '')
                        .replace(/\s*```\s*$/, '');
                    return {result: schema.parse(JSON.parse(jsonrepair(unfenced))), parseError: null};
                } catch (repairError) {
                    return {
                        result: null,
                        parseError: `${error.message}\nDeterministic JSON repair failed: ${repairError.message}`
                    };
                }
            }
        })
        .addNode('repair', async state => {
            const response = await llm.invoke([
                ...state.messages,
                {role: 'assistant', content: state.response},
                {
                    role: 'user',
                    content: `Your previous ${name} output failed schema validation: ${state.parseError}. Return ONLY a corrected JSON object matching the schema.`
                }
            ]);
            return {response: String(response.content), repaired: true};
        })
        .addEdge(START, 'generate')
        .addEdge('generate', 'validate')
        .addConditionalEdges('validate', state => state.result || state.repaired ? END : 'repair')
        .addEdge('repair', 'validate')
        .compile();

    const state = await graph.invoke({messages});
    if (!state.result) throw new Error(state.parseError || `${name} output could not be validated`);
    return state.result;
}

async function mapWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({length: Math.min(concurrency, items.length)}, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

app.get('/health', (_req, res) => res.json({ok: true, llm: {...getLLMConfig(), apiKey: undefined}}));

app.post('/planner', async (req, res) => {
    try {
        const result = await invokeStructured(
            `You are Planner in a multi-agent coding system. Decompose the user's request into a small, safe, testable implementation plan. For this environment the generated project MUST use only Node.js built-in modules, keep all application data in memory, use node:test for automated tests, and declare no dependencies or devDependencies. Do not propose npm install commands, databases, ORMs, Express, Jest, React, or any external package. Keep the file count minimal and make it runnable in an isolated Node.js Docker container. Identify genuine ambiguity and ask for clarification only when required.`,
            req.body,
            plannerSchema,
            'planner_output'
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/coder', async (req, res) => {
    try {
        const steps = Array.isArray(req.body?.plan?.steps) ? req.body.plan.steps : [];
        const jobsByPath = new Map();
        for (const step of steps) {
            for (const targetFile of step.files || []) jobsByPath.set(targetFile, {step, targetFile});
        }
        const jobs = [...jobsByPath.values()];
        if (!jobs.length) jobs.push({step: steps[0] || req.body?.plan, targetFile: 'package.json'});

        const results = await mapWithConcurrency(jobs, 3, (job, index) => invokeStructured(
            `You are Coder file worker ${index + 1} of ${jobs.length}. Generate exactly one complete file at the requested target path for a coherent, small, runnable JavaScript project. Use only Node.js built-in modules, keep application state entirely in memory, and use node:test with built-in assertions. package.json must contain empty dependencies and devDependencies objects and use node --test for its test script. Never import Express, React, Jest, SQLite, or any external package. Never use absolute paths, patches, placeholders, or unrelated files. Ensure this file is consistent with the overall request and plan summary.`,
            {
                request: req.body?.request,
                planSummary: req.body?.plan?.summary,
                assignedStep: job.step,
                targetFile: job.targetFile,
                humanFeedback: req.body?.humanFeedback || req.body?.human_feedback || []
            },
            coderSchema,
            `coder_file_${index + 1}_output`
        ));

        const filesByPath = new Map();
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            const targetFile = jobs[index].targetFile;
            const file = result.files.find(item => item.path === targetFile) || result.files[0];
            filesByPath.set(targetFile, {...file, path: targetFile});
        }

        res.json({
            summary: results.map(result => result.summary).join(' '),
            files: [...filesByPath.values()],
            installCommand: results.find(result => result.installCommand)?.installCommand || 'npm install',
            testCommand: results.find(result => result.testCommand)?.testCommand || 'npm test',
            runCommand: results.find(result => result.runCommand)?.runCommand || 'npm start'
        });
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/reviewer', async (req, res) => {
    try {
        const result = await invokeStructured(
            `You are Tester/Reviewer. Review the real sandbox execution result against the project request and plan. Never claim success when the exit code is non-zero or required behavior is missing.`,
            req.body,
            reviewerSchema,
            'reviewer_output'
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/fixer', async (req, res) => {
    try {
        const infrastructureTimeout = Number(req.body?.execution?.exitCode) === 124
            && /timed out/i.test(req.body?.execution?.stderr || '');
        if (infrastructureTimeout) {
            const currentFiles = Array.isArray(req.body?.currentFiles) ? req.body.currentFiles : [];
            const packageFile = currentFiles.find(file => file.path === 'package.json') || currentFiles[0];
            if (!packageFile) throw new Error('Infrastructure retry requires at least one current project file');
            return res.json({
                summary: 'No source change required; retrying after an infrastructure command timeout.',
                files: [packageFile],
                testCommand: 'npm test'
            });
        }

        const currentFiles = Array.isArray(req.body?.currentFiles) ? req.body.currentFiles : [];
        const packageFile = currentFiles.find(file => file.path === 'package.json');
        let packageJson;
        try {
            packageJson = packageFile ? JSON.parse(packageFile.content) : null;
        } catch {
            packageJson = null;
        }
        const zeroDependencyProject = packageJson
            && !Object.keys(packageJson.dependencies || {}).length
            && !Object.keys(packageJson.devDependencies || {}).length;

        if (zeroDependencyProject) {
            const diagnostic = [
                req.body?.execution?.stdout,
                req.body?.execution?.stderr,
                ...(req.body?.recommendedFixes || [])
            ].filter(Boolean).join('\n');
            const targetPaths = new Set();
            for (const file of currentFiles) {
                if (diagnostic.includes(file.path)) targetPaths.add(file.path);
            }
            if (/404|econnrefused|server|route|done is not a function/i.test(diagnostic)) {
                targetPaths.add('server.js');
                targetPaths.add('test/server.test.js');
            }
            const jobs = currentFiles.filter(file => targetPaths.has(file.path));
            if (!jobs.length && packageFile) jobs.push(packageFile);
            const contextFiles = currentFiles.filter(file =>
                ['package.json', 'server.js', 'test/server.test.js'].includes(file.path)
            );
            const results = await mapWithConcurrency(jobs, 2, (file, index) => invokeStructured(
                `You are Fixer file worker ${index + 1} of ${jobs.length}. Replace exactly the requested target file so the real node:test failures are fixed. Use only Node.js built-in modules and keep state in memory. Return concise, complete file content and no unrelated files. Ensure the HTTP server and tests use identical route paths, validate empty todo text, support active/completed filters, and use promise-based node:test setup/teardown without callback-style done arguments.`,
                {
                    request: req.body?.request,
                    targetFile: file.path,
                    failureSummary: diagnostic.slice(-3500),
                    contextFiles
                },
                fixerSchema,
                `fixer_file_${index + 1}_output`,
                {maxTokens: 4096}
            ));
            return res.json({
                summary: results.map(result => result.summary).join(' '),
                files: results.map((result, index) => ({
                    ...(result.files.find(item => item.path === jobs[index].path) || result.files[0]),
                    path: jobs[index].path
                })),
                testCommand: 'npm test'
            });
        }

        const result = await invokeStructured(
            `You are Fixer. Use the real sandbox error, previous attempts, recommended fixes, and current files. Return only files that must be replaced or added. Do not repeat an unsuccessful fix unchanged.`,
            req.body,
            fixerSchema,
            'fixer_output'
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.listen(port, '0.0.0.0', () => console.log(`agent-service listening on ${port}`));
