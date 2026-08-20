import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const base = process.env.N8N_PUBLIC_URL || 'http://localhost:5678';
const key = process.env.N8N_API_KEY;

if (!key) {
    throw new Error('Set N8N_API_KEY before importing workflows');
}

const headers = {
    'content-type': 'application/json',
    'X-N8N-API-KEY': key
};

function request(url, {method = 'GET', headers: requestHeaders = {}, body} = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === 'https:' ? https : http;
        const payload = body === undefined ? null : String(body);
        const req = client.request(target, {
            method,
            headers: {
                ...requestHeaders,
                ...(payload ? {'content-length': Buffer.byteLength(payload)} : {})
            }
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                text += chunk;
            });
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                text: async () => text,
                json: async () => JSON.parse(text)
            }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const existingResponse = await request(`${base}/api/v1/workflows?limit=250`, {headers});
if (!existingResponse.ok) {
    throw new Error(`Unable to list n8n workflows: ${existingResponse.status} ${await existingResponse.text()}`);
}

const existing = (await existingResponse.json()).data || [];
const workflowByName = new Map(existing.map(workflow => [workflow.name, workflow]));

for (const file of await fs.readdir('n8n/workflows')) {
    if (!file.endsWith('.json')) continue;

    const raw = JSON.parse(await fs.readFile(path.join('n8n/workflows', file), 'utf8'));
    const body = {
        name: raw.name,
        nodes: raw.nodes,
        connections: raw.connections,
        settings: raw.settings || {}
    };
    const previous = workflowByName.get(raw.name);
    const endpoint = previous
        ? `${base}/api/v1/workflows/${previous.id}`
        : `${base}/api/v1/workflows`;
    const method = previous ? 'PUT' : 'POST';
    const response = await request(endpoint, {
        method,
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`${file}: ${method} failed (${response.status}): ${await response.text()}`);
    }

    const workflow = await response.json();
    console.log(`${file}: ${previous ? 'updated' : 'created'} workflow ${workflow.id}`);
}
