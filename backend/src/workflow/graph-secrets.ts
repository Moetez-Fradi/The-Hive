import { decryptJson, encryptJson } from '../utlis/crypot';

type GraphNode = { id: string; env?: Record<string, string>; envCipher?: string; envKeys?: string[]; [k: string]: any };
type Graph = { nodes?: GraphNode[]; edges?: any[]; [k: string]: any };

export function sealGraph<T extends Graph>(graph: T): T {
  if (!graph?.nodes) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(({ env, ...node }) => {
      if (!env || !Object.keys(env).length) return node;
      return { ...node, envCipher: encryptJson(env), envKeys: Object.keys(env) };
    }),
  };
}

export function openGraph<T extends Graph>(graph: T): T {
  if (!graph?.nodes) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(({ envCipher, ...node }) => {
      if (node.env && Object.keys(node.env).length) return node;
      return envCipher ? { ...node, env: decryptJson(envCipher) } : node;
    }),
  };
}

export function publicGraph<T extends Graph>(graph: T): T {
  if (!graph?.nodes) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(({ env, envCipher, ...node }) => ({
      ...node,
      envKeys: node.envKeys ?? Object.keys(env ?? {}),
    })),
  };
}

export function withStoredSecrets<T extends Graph>(graph: T, stored: Graph): T {
  if (!graph?.nodes || !stored?.nodes) return graph;
  const byId = new Map(stored.nodes.map(n => [n.id, n]));
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      if ((node.env && Object.keys(node.env).length) || node.envCipher) return node;
      const prev = byId.get(node.id);
      return prev?.envCipher ? { ...node, envCipher: prev.envCipher, envKeys: prev.envKeys } : node;
    }),
  };
}
