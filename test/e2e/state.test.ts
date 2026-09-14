import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAvailableNode, isUnavailableNode } from '../../src/types.ts';
import {
    assertKeysAreEqualAcrossNodes,
    call,
    CLUSTER_CONFIG,
    describeCluster,
    waitForShutdown,
    waitUntilAvailable,
    type CliFailure,
} from '../helpers/cli.ts';

interface LoadParameters {
    invocations: number,
    concurrency: number, // the number of parallel requests
    sleep: number // how many ms to wait in between requests
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

describe('nodes agree on state when under load with a coordinator available', () => {
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

    describe('when the coordinator is unavailable', () => {

        before(async () => {
            const description = await describeCluster();
            for (const [nodeId, nodeStatus] of Object.entries(description)) {
                if (isUnavailableNode(nodeStatus) || !nodeStatus.isCoordinator) {
                    continue;
                }
                process.kill(nodeStatus.pid);
                console.log(`Killed coordinator node ${nodeId} with pid ${nodeStatus.pid}`);
                await waitForShutdown(nodeStatus.url);
            }
        });
        
        it('should report unreachable nodes as unavailable without failing', async () => {
            const description = await describeCluster();
            const unavailable = Object.values(description).filter(isUnavailableNode);
            assert.ok(unavailable.length >= 1, 'expected at least one unavailable node after killing the coordinator');
            for (const node of unavailable) {
                assert.equal(node.unavailable, true);
                assert.ok(node.url.length > 0);
                assert.ok(node.error.length > 0);
            }
            const live = Object.values(description).filter(isAvailableNode);
            assert.ok(live.length >= 1, 'expected remaining nodes to still be described');
        });

        describe('when the request is a read', () => {
            it('should complete successfully and return the correct value', async () => {
                const result = await call('get', { key: 'key-0' });
                assert.ok(result.includes('value-0'));
            });
        });

        describe('when the request is a write', () => {
            it('should fail immedate requests with a coordinator unavailable error', async () => {
                const failure = await call('set', { key: 'foo', value: 'bar' }).then(
                    (stdout) => {
                        throw new Error(`expected set to fail, got: ${stdout}`);
                    },
                    (err: CliFailure) => err,
                );
                assert.equal(failure.code, 2);
                assert.match(failure.reason, /coordinator unavailable/);
            });

            it('should succeed after a short delay when leader election completes', async () => {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const result = await call('set', { key: 'foo', value: 'bar' });
                assert.match(result, /OK/);
            });
        });        
    });

    describe('adding a node to the cluster', () => {
        const originalConfig = readFileSync(CLUSTER_CONFIG, 'utf8');
        after(() => {
            writeFileSync(CLUSTER_CONFIG, originalConfig);
        });

        it('catches the new node up so every available node reports the same key count', async () => {
            for (let i = 0; i < 10; i++) {
                await call('set', { key: `join-key-${i}`, value: `join-value-${i}` });
            }
            const stdout = await call('cluster', {
                subcommand: 'add',
                target: 'http://127.0.0.1:8007',
                cluster: CLUSTER_CONFIG,
            });
            const added = JSON.parse(stdout) as { url: string };
            await waitUntilAvailable(added.url);
            await assertKeysAreEqualAcrossNodes();
        });
    });
})
