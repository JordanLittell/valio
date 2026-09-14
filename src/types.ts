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
  isCoordinator: boolean;
};

/** Output of `valio cluster describe`: node id -> that node's status block. */
export type ClusterDescription = Record<string, StatusResponse>;
