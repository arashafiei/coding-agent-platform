import express from 'express';
import Docker from 'dockerode';
import fs from 'node:fs/promises';
import path from 'node:path';

const app = express();
app.use(express.json({limit: '1mb'}));
const docker = new Docker({socketPath: '/var/run/docker.sock'});
const root = '/workspace/projects';
let resolvedHostRoot;

async function getHostProjectsRoot() {
    if (process.env.RUNNER_HOST_PROJECTS_ROOT) return process.env.RUNNER_HOST_PROJECTS_ROOT;
    if (resolvedHostRoot) return resolvedHostRoot;
    const containers = await docker.listContainers({
        filters: {label: ['com.docker.compose.service=runner']}
    });
    const mount = containers.flatMap(container => container.Mounts || [])
        .find(candidate => candidate.Destination === root);
    if (!mount?.Source) throw new Error('Could not resolve the host projects mount');
    resolvedHostRoot = mount.Source;
    return resolvedHostRoot;
}

function demuxLogs(buffer) {
    let offset = 0;
    const stdout = [];
    const stderr = [];
    while (offset + 8 <= buffer.length) {
        const stream = buffer[offset];
        const length = buffer.readUInt32BE(offset + 4);
        const start = offset + 8;
        const end = start + length;
        if (end > buffer.length || ![1, 2].includes(stream)) break;
        (stream === 2 ? stderr : stdout).push(buffer.subarray(start, end));
        offset = end;
    }
    if (offset === 0) {
        return {stdout: buffer.toString('utf8').replaceAll('\0', ''), stderr: ''};
    }
    return {
        stdout: Buffer.concat(stdout).toString('utf8').replaceAll('\0', ''),
        stderr: Buffer.concat(stderr).toString('utf8').replaceAll('\0', '')
    };
}
app.get('/health', async (_q, r) => {
    try {
        await docker.ping();
        r.json({ok: true})
    } catch (e) {
        r.status(500).json({ok: false, error: e.message})
    }
});

async function runContainer({projectDir, command, networkMode, timeout, memory, cpus}) {
    let container;
    let timedOut = false;
    try {
        container = await docker.createContainer({
            Image: 'node:22-alpine',
            Cmd: ['sh', '-lc', command],
            WorkingDir: '/workspace',
            HostConfig: {
                Binds: [`${projectDir}:/workspace:rw`],
                Memory: memory,
                NanoCpus: cpus * 1e9,
                NetworkMode: networkMode,
                ReadonlyRootfs: false,
                AutoRemove: false
            }
        });
        await container.start();
        const timer = setTimeout(() => {
            timedOut = true;
            container.kill().catch(() => {});
        }, timeout);
        const result = await container.wait();
        clearTimeout(timer);
        const logs = await container.logs({stdout: true, stderr: true}).catch(() => Buffer.from(''));
        const output = demuxLogs(logs);
        return {
            exitCode: timedOut ? 124 : result.StatusCode,
            stdout: output.stdout,
            stderr: timedOut
                ? `${output.stderr}\nCommand timed out after ${timeout}ms`
                : output.stderr
        };
    } finally {
        if (container) await container.remove({force: true}).catch(() => {});
    }
}

app.post('/execute', async (req, res) => {
    const start = Date.now();
    try {
        const {projectSlug, command = 'npm test'} = req.body;
        if (!projectSlug || path.basename(projectSlug) !== projectSlug) {
            return res.status(400).json({error: 'Invalid project slug'});
        }
        const projectDir = path.join(root, projectSlug);
        const hostProjectDir = path.join(await getHostProjectsRoot(), projectSlug);
        await fs.access(projectDir);
        const timeout = Number(process.env.RUNNER_TIMEOUT_SECONDS || 90) * 1000;
        const memory = Number(process.env.RUNNER_MEMORY_MB || 512) * 1024 * 1024;
        const cpus = Number(process.env.RUNNER_CPUS || 1);
        const install = await runContainer({
            projectDir: hostProjectDir,
            command: `if [ -f package.json ] && node -e "const p=require('./package.json'); process.exit(Object.keys(p.dependencies||{}).length + Object.keys(p.devDependencies||{}).length ? 0 : 1)"; then npm install --cache /workspace/.npm-cache --ignore-scripts --no-audit --no-fund --fetch-retries=2 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=5000 --fetch-timeout=30000 --maxsockets=1; fi`,
            networkMode: 'bridge',
            timeout,
            memory,
            cpus
        });
        if (install.exitCode !== 0) {
            return res.json({...install, durationMs: Date.now() - start, phase: 'install'});
        }

        const execution = await runContainer({
            projectDir: hostProjectDir,
            command,
            networkMode: 'none',
            timeout,
            memory,
            cpus
        });
        res.json({
            ...execution,
            durationMs: Date.now() - start,
            phase: 'test'
        });
    } catch (e) {
        res.json({exitCode: 1, stdout: '', stderr: e.message, durationMs: Date.now() - start, phase: 'runner'})
    }
});
app.listen(Number(process.env.PORT || 4200), '0.0.0.0');
