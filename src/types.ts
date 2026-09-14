export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type GetResponse = { key: string; value: JsonValue };
export type SetResponse = { key: string; value: JsonValue };
export type ListResponse = { data: Record<string, JsonValue> };
export type ErrorResponse = { error: string };

export type StatusResponse = {
  /** Node id from the cluster config; null when running standalone. */
  id: number | null;
  url: string | null;
  peers: number[];
  pid: number;
  uptimeMs: number;
  keys: number;
  /** True when this node currently leads. Runtime, not config. */
  isCoordinator: boolean;
  /** Node id of the current leader; null when none is known. */
  leaderId: number | null;
  /** Paxos epoch of the current leader; null when none is known. */
  epoch: number | null;
  /** `initializing` until WAL catch-up finishes; then the node accepts client requests. */
  state: 'initializing' | 'available';
};

/** Unreachable or otherwise unqueryable node in `valio cluster describe` output. */
export type UnavailableNodeStatus = {
  id: number;
  url: string;
  unavailable: true;
  error: string;
};

/** One node's entry in `valio cluster describe`: live /status, or an unavailable marker. */
export type NodeDescription = StatusResponse | UnavailableNodeStatus;

/** Output of `valio cluster describe`: node id -> that node's status block. */
export type ClusterDescription = Record<string, NodeDescription>;

export function isUnavailableNode(node: NodeDescription): node is UnavailableNodeStatus {
  return 'unavailable' in node && node.unavailable === true;
}

export function isAvailableNode(node: NodeDescription): node is StatusResponse {
  return !isUnavailableNode(node);
}
