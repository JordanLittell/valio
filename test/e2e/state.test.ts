import { spawn } from 'node:child_process';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { ClusterDescription } from '../../src/types.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const CLUSTER_CONFIG = fileURLToPath(new URL('../../cluster.json', import.meta.url));

interface LoadParameters {
    invocations: number,
    concurrency: number, // the number of parallel requests
    sleep: number // how many ms to wait in between requests
}

interface CliFailure {
    code: number;
    reason: string;
}

function buildCliArgs(operation: string, payload: Record<string, unknown>): string[] {
    const args: string[] = [];

    switch (operation) {
        case 'get':
        case 'del':
            args.push(operation, String(payload.key));
            break;
        case 'set': {
            const value = payload.value;
            if (typeof value === 'string') {
                args.push(operation, String(payload.key), value);
            } else {
                args.push(operation, String(payload.key), JSON.stringify(value), '--json');
            }
            break;
        }
        case 'cluster':
            if (payload.subcommand === undefined) {
                throw new Error('cluster requires a subcommand');
            }
            args.push(operation, String(payload.subcommand));
            break;
        case 'list':
        case 'clear':
        case 'status':
            args.push(operation);
            break;
        default:
            args.push(operation);
            break;
    }

    if (payload.url !== undefined) {
        args.push('--url', String(payload.url));
    }

    if (payload.cluster !== undefined) {
        args.push('--cluster', String(payload.cluster));
    }

    return args;
}

function call(operation: string, payload: Record<string, unknown> = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...buildCliArgs(operation, payload)], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk;
        });

        child.on('error', (err) => {
            reject({ code: 1, reason: err.message } satisfies CliFailure);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject({
                    code: code ?? 1,
                    reason: stderr.trim() || stdout.trim() || `exit ${code}`,
                } satisfies CliFailure);
            }
        });
    });
}

/** Runs `valio cluster describe` and parses the node id -> status map it prints. */
async function describeCluster(): Promise<ClusterDescription> {
    const stdout = await call('cluster', { subcommand: 'describe', cluster: CLUSTER_CONFIG });
    try {
        return JSON.parse(stdout) as ClusterDescription;
    } catch (err) {
        throw new Error(`could not parse cluster describe output: ${(err as Error).message}\n${stdout}`);
    }
}

/** Every node should hold the same number of keys once the load has replicated. */
async function assertKeysAreEqualAcrossNodes(): Promise<void> {
    const description = await describeCluster();
    const counts = Object.entries(description).map(([id, status]) => ({ id, keys: status.keys }));

    if (counts.length === 0) {
        throw new Error('cluster describe returned no nodes');
    }

    const expected = counts[0]!.keys;
    if (counts.some(({ keys }) => keys !== expected)) {
        const detail = counts.map(({ id, keys }) => `node ${id}: ${keys}`).join(', ');
        throw new Error(`key counts differ across nodes (${detail})`);
    }

    console.log(`All ${counts.length} nodes report ${expected} keys`);
}

async function loadTest(params: LoadParameters) {
    let invocationCount = 0;

    while(invocationCount < params.invocations) {
        const requests = [];
        for(let i =0; i < params.concurrency; i++) {
            requests.push(call('set', { key: `key-${invocationCount + i}`, value: `value-${invocationCount + i}` }))
            await new Promise(resolve => setTimeout(resolve, params.sleep));
        }
        console.log(`Sending ${params.concurrency} concurrent requests`);
        await Promise.all(requests);
        console.log(`Completed ${params.concurrency} concurrent requests`);
        invocationCount += params.concurrency;
        console.log(`Completed ${invocationCount} invocations`);
    }
}

describe('nodes agree on state when under load with a leader available', () => {
    const lightTest: LoadParameters = {
        invocations: 20,
        concurrency: 5,
        sleep: 200
    }
    
    describe(`invoking ${lightTest.invocations} times with ${lightTest.concurrency} concurrent requests`, () => {
        it('should complete successfully and all nodes report the same number of keys', () => {
            return loadTest(lightTest).then(() => {
                return assertKeysAreEqualAcrossNodes();
            }).catch(err => {
                console.error(err);
                process.exit(1);
            });
        });
    });

    describe('when the leader is unavailable', () => {

        before(async () => {
            const description = await describeCluster();
            Object.keys(description).forEach(async (nodeId) => {
                const nodeConfig = description[nodeId]!;
                if (nodeConfig.isLeader) {
                    const pid = nodeConfig.pid;
                    process.kill(pid);
                    console.log(`Killed leader node ${nodeId} with pid ${pid}`);
                }
                
            });
        });
        
        describe('when the request is a read', () => {
            it('should complete successfully and return the correct value', async () => {
                const result = await call('get', { key: 'key-0' });
                assert.ok(result.includes('value-0'));
            });
        });

        describe('when the request is a write', () => {
            it('should fail with a leader unavailable error', async () => {
                const result = await call('set', { key: 'foo', value: 'bar' });
                assert.ok(result.includes('leader unavailable'));
            });
        });        
    });
})