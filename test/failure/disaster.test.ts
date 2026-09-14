import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isAvailableNode, isUnavailableNode, type ClusterDescription, type StatusResponse } from '../../src/types.ts';
import { call, describeCluster, waitForShutdown } from '../e2e/state.test.ts';


describe('when there is exactly 2F+1 nodes available', () => {
    it('should report the cluster as unavailable with an accurate description', async () => {
        const description = await describeCluster();
        const available = Object.values(description).filter(isAvailableNode);
        assert.equal(available.length, 2 * Math.floor(Object.values(description).length / 2) + 1);

        const result = await call('set', { key: 'foo', value: 'bar' });
        assert.match(result, /no node available/);
    });
});

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

        const result = await call('set', { key: 'foo', value: 'bar' });
        assert.match(result, /no node available/);
    });
});