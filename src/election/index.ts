import type { Router } from 'express';
import type { NodeConfig, NodeInfo } from '../config.ts';
import { post } from '../distributed/peer.ts';
import type { JsonValue } from '../types.ts';
import { Accepter } from './accepter.ts';
import { Learner } from './learner.ts';
import { Proposer } from './proposer.ts';
import { electionRouter, LEARN_PATH } from './routes.ts';
import type { AcceptedMessage } from './types.ts';

export { Accepter, type LearnerBroadcast } from './accepter.ts';
export { Learner } from './learner.ts';
export { Proposer, type ProposalResult } from './proposer.ts';
export { ACCEPT_PATH, LEARN_PATH, PREPARE_PATH } from './routes.ts';

export type Election = {
  proposer: Proposer;
  accepter: Accepter;
  learner: Learner;
  router: Router;
};

export type ElectionOptions = {
  /** Called once when a quorum is known to have accepted a value. */
  onConsensus?: ((value: JsonValue) => void) | undefined;
};

/**
 * Every node runs all three Paxos roles, so there is no separate membership list
 * per role: the cluster's peer list is the accepter list and the learner list.
 */
export function createElection(node: NodeConfig, options: ElectionOptions = {}): Election {
  const quorum = Math.floor(node.nodes.length / 2) + 1;
  const learner = new Learner(quorum, options.onConsensus);
  const accepter = new Accepter(node.self.id, (message) => {
    // Not awaited: the proposer's ACCEPTED answer must not wait on the learner fan-out.
    broadcastAccepted(node.peers, learner, message).catch((err: unknown) => {
      console.warn(`election ballot ${message.id} broadcast failed: ${(err as Error).message}`);
    });
  });

  return {
    proposer: new Proposer(node.self, node.peers, accepter),
    accepter,
    learner,
    router: electionRouter(accepter, learner),
  };
}

/**
 * Tells every learner what we accepted. Best effort: a learner that misses this
 * just doesn't know the outcome yet, and the proposer counts accepts itself, so a
 * lost message cannot change what was chosen.
 */
async function broadcastAccepted(peers: NodeInfo[], local: Learner, message: AcceptedMessage): Promise<void> {
  await Promise.all([
    local.learn(message),
    ...peers.map(async (peer) => {
      const res = await post(peer.url, LEARN_PATH, message);
      if (!res.ok) console.warn(`election ballot ${message.id} not learned by node ${peer.id}: ${res.error}`);
    }),
  ]);
}
