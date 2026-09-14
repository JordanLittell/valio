import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUnavailableNode } from '../../src/types.ts';
import { call, describeCluster, waitForShutdown, type CliFailure } from '../helpers/cli.ts';


describe('when there is no quorum of nodes available', () => {
    it('should report the cluster as unavailable with an accurate description', async () => {
        const description = await describeCluster();
        let count = 0;
        const majority = Math.floor(Object.values(description).length / 2) + 1;
        for (const [id, status] of Object.entries(description)) {
            if (isUnavailableNode(status)) {
                continue;
            }
            count++;
            if (count >= majority) {
                break;
            }
            process.kill(status.pid);
            console.log(`Killed node ${id} with pid ${status.pid}`);
            await waitForShutdown(status.url);
        }

        const result = await call('set', { key: 'foo', value: 'bar' }).then(
            (stdout) => {
                throw new Error(`expected set to fail, got: ${stdout}`);
            },
            (err: CliFailure) => err,
        );
        assert.equal(result.code, 2);
        assert.match(result.reason, /no node available/);
    });
});
