import express from 'express';
import {createLLM, getLLMConfig} from '../../../packages/llm/src/index.js';

const app = express();
app.use(express.json({limit: '2mb'}));
const port = Number(process.env.PORT || 4100);

function extractJson(text) {
    const raw = typeof text === 'string' ? text : String(text);
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error('Model did not return JSON');
    return JSON.parse(candidate.slice(start, end + 1));
}

async function invokeJson(system, payload) {
    const llm = createLLM();
    const response = await llm.invoke([
        {role: 'system', content: `${system}\nReturn ONLY valid JSON, no markdown.`},
        {role: 'user', content: JSON.stringify(payload, null, 2)}
    ]);
    return extractJson(response.content);
}

app.get('/health', (_req, res) => res.json({ok: true, llm: {...getLLMConfig(), apiKey: undefined}}));

app.post('/planner', async (req, res) => {
    try {
        const result = await invokeJson(
            `You are Planner in a multi-agent coding system. Decompose the user's JavaScript/TypeScript project request into a safe, testable implementation plan. Prefer Node.js/TypeScript. Identify ambiguity and whether human clarification is needed.`,
            req.body
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/coder', async (req, res) => {
    try {
        const result = await invokeJson(
            `You are Coder. Generate a small runnable JavaScript/TypeScript project from the approved plan. Output {summary, files:[{path,content}], installCommand, testCommand, runCommand}. Never use absolute paths. Keep dependencies minimal.`,
            req.body
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/reviewer', async (req, res) => {
    try {
        const result = await invokeJson(
            `You are Tester/Reviewer. Review the real execution result, exit code, stdout/stderr and project goal. Return {passed:boolean, reason:string, recommendedFixes:string[]}. Never claim success if exitCode is non-zero.`,
            req.body
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.post('/fixer', async (req, res) => {
    try {
        const result = await invokeJson(
            `You are Fixer. Use the real error, previous attempts and current files. Return {summary, files:[{path,content}], testCommand}. Only include files that must be replaced or added. Do not repeat a failed fix unchanged.`,
            req.body
        );
        res.json(result);
    } catch (e) {
        res.status(500).json({error: e.message});
    }
});

app.listen(port, '0.0.0.0', () => console.log(`agent-service listening on ${port}`));
