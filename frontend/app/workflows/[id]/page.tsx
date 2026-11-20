'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import axios from 'axios';
import ReactFlow, {
  MiniMap,
  Controls,
  Background,
  Node,
  Edge,
  ReactFlowProvider,
  Handle,
  Position,
  NodeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useUserStore } from '../../../store/useUserStore';
import RunProof from '../../../components/RunProof';

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:3001') as string;

type RunSummary = {
  id: string;
  status: string;
  mode: string;
  runtimeMs: number;
  createdAt: string;
  inputHash: string;
  outputHash: string;
  runHash: string;
  hcsTopicId?: string | null;
  hcsSequence?: number | null;
  hcsTxId?: string | null;
  links?: { topicUrl: string; messageUrl: string; transactionUrl: string | null } | null;
};

interface Workflow {
  id: string;
  name: string;
  description?: string;
  ownerUserId: string;
  usageUrl?: string | null; // <--- optional usage URL at workflow level
  graphJson: {
    nodes: Array<{ id: string; name: string; toolId?: string }>;
    edges: Array<{ from: string; to: string; condition?: string; mapping?: any }>;
  };
  fixedUsageFee: number;
  createdAt: string;
  owner?: { id: string; displayName?: string; email?: string };
  estimatedCost?: number;
  workflowStatus?: string;
}

// --- Custom node for ReactFlow ---
function CustomNode({ id, data }: NodeProps) {
  return (
    <div className="w-72 group">
      <Handle type="target" position={Position.Left} id={`in-${id}`} className="!bg-cyan-400/95 !w-3 !h-3" />

      <div className="p-4 rounded-2xl shadow-lg border border-white/10 bg-gradient-to-br from-[#0a1b2e]/70 to-[#0e263d]/60 hover:scale-[1.03] transition-transform">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-12 h-12 rounded-full bg-cyan-400/10 border border-cyan-400/20 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="opacity-95">
              <path d="M12 2v6" stroke="#67F6FF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 10h12" stroke="#67F6FF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 14h12" stroke="#67F6FF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="flex-1">
            <div className="text-[15px] font-semibold leading-tight text-white break-words">
              {data?.labelTitle ?? data?.label ?? 'Untitled'}
            </div>
            <div className="mt-2 text-xs text-gray-400">
              ID: <span className="font-mono text-[11px] text-gray-200 break-words">{id}</span>
            </div>
          </div>
        </div>
      </div>

      <Handle type="source" position={Position.Right} id={`out-${id}`} className="!bg-cyan-400/95 !w-3 !h-3" />
    </div>
  );
}

export default function WorkflowDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workflowId = (params as any).id as string;
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const { token, userId } = useUserStore();

  useEffect(() => {
    if (!workflowId) return;
    axios.get<RunSummary[]>(`${API_BASE}/workflows/${workflowId}/runs`).then(r => setRuns(r.data)).catch(() => setRuns([]));
  }, [workflowId]);

  const startDeployment = async () => {
    if (!workflow) return;
    setStarting(true);
    try {
      const res = await axios.post(
        `${API_BASE}/workflow-instances`,
        { workflowId: workflow.id },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      router.push(`/workflows/testing/${res.data.id}`);
    } catch (err: any) {
      alert(err?.response?.data?.message ?? err.message);
      setStarting(false);
    }
  };

  useEffect(() => {
    const loadWorkflow = async () => {
      setLoading(true);
      try {
        const url = `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflows/${workflowId}`;
        const res = await axios.get(url);
        setWorkflow(res.data.workflow ?? res.data);
      } catch (err) {
        console.error('Failed to load workflow:', err);
        setWorkflow(null);
      } finally {
        setLoading(false);
      }
    };
    if (workflowId) loadWorkflow();
  }, [workflowId]);

  const { nodes, edges } = useMemo(() => {
    if (!workflow?.graphJson) return { nodes: [], edges: [] };

    const gNodes = workflow.graphJson.nodes ?? [];
    const gEdges = workflow.graphJson.edges ?? [];

    const idToNode = new Map<string, { id: string; name: string; toolId?: string }>();
    gNodes.forEach(n => idToNode.set(n.id, n));

    // --- layout calculation ---
    const indegree = new Map<string, number>();
    idToNode.forEach((_, id) => indegree.set(id, 0));
    gEdges.forEach(e => indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1));

    const adjacency = new Map<string, string[]>();
    idToNode.forEach((_, id) => adjacency.set(id, []));
    gEdges.forEach(e => adjacency.get(e.from)?.push(e.to));

    const queue: string[] = [];
    indegree.forEach((d, id) => { if (d === 0) queue.push(id); });

    const level = new Map<string, number>();
    queue.forEach(id => level.set(id, 0));

    const q = [...queue];
    while (q.length) {
      const cur = q.shift()!;
      const curLevel = level.get(cur) ?? 0;
      for (const nb of adjacency.get(cur) ?? []) {
        level.set(nb, Math.max(level.get(nb) ?? 0, curLevel + 1));
        indegree.set(nb, (indegree.get(nb) ?? 1) - 1);
        if (indegree.get(nb) === 0) q.push(nb);
      }
    }

    let maxAssigned = -1;
    level.forEach(v => (maxAssigned = Math.max(maxAssigned, v)));
    idToNode.forEach((_, id) => {
      if (!level.has(id)) {
        level.set(id, maxAssigned + 1);
        maxAssigned++;
      }
    });

    const levelsMap = new Map<number, string[]>();
    level.forEach((lvl, id) => {
      const arr = levelsMap.get(lvl) ?? [];
      arr.push(id);
      levelsMap.set(lvl, arr);
    });

    const nodesResult: Node[] = [];
    const levelGapX = 360;
    const levelGapY = 220;

    Array.from(levelsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .forEach(([lvl, ids]) => {
        const count = ids.length;
        ids.forEach((id, idx) => {
          const centerOffset = ((count - 1) * levelGapX) / 2;
          const x = idx * levelGapX - centerOffset;
          const y = lvl * levelGapY;
          const n = idToNode.get(id)!;

          nodesResult.push({
            id,
            type: 'custom',
            data: { labelTitle: n.name, toolId: n.toolId },
            position: { x, y },
            draggable: false,
            selectable: true,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
          });
        });
      });

    const edgesResult: Edge[] = gEdges.map((e: any, i: number) => {
      const duplicates = gEdges.filter(x => x.from === e.from && x.to === e.to);
      const offsetIndex = duplicates.findIndex(x => x === e);
      const yOffset = offsetIndex * 25;

      return {
        id: `e-${e.from}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        label: e.condition ?? undefined,
        animated: !!e.condition,
        type: 'smoothstep',
        style: { strokeWidth: 2 },
        labelStyle: { fontSize: 13, fill: '#e6f7ff', transform: `translateY(${yOffset}px)` },
        labelBgStyle: { fill: 'rgba(0,0,0,0.36)' },
        labelBgPadding: [6, 8],
        labelBgBorderRadius: 8,
      };
    });

    return { nodes: nodesResult, edges: edgesResult };
  }, [workflow]);

  if (loading)
    return <div className="min-h-screen flex items-center justify-center bg-[#050b15] text-gray-300 text-lg font-medium">Loading workflow...</div>;

  if (!workflow)
    return <div className="min-h-screen flex items-center justify-center bg-[#050b15] text-gray-400 text-lg font-medium">Workflow not found</div>;

  return (
    <div className="min-h-screen p-10 bg-[#050b15] text-white font-inter">
      <div className="max-w-7xl mx-auto space-y-14">
        {/* --- Header --- */}
        <header className="flex flex-col sm:flex-row items-start justify-between gap-8">
          <div className="space-y-5">
            <h1 className="text-5xl font-extrabold leading-tight tracking-tight">{workflow.name}</h1>
            <p className="text-gray-300 max-w-2xl leading-relaxed text-2xl">
              {workflow.description ?? 'No description provided.'}
            </p>
            <br></br>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-2 gap-5 text-sm text-gray-300">
              <div><span className="font-semibold text-cyan-300">Owner:</span> {workflow.owner?.displayName ?? workflow.owner?.email ?? '—'}</div>
              <div><span className="font-semibold text-cyan-300">Created:</span> {new Date(workflow.createdAt).toLocaleString()}</div>
              <div><span className="font-semibold text-cyan-300">Status:</span> {workflow.workflowStatus === 'DEPLOYED' ? 'Deployed' : 'Not deployed'}</div>
              <div><span className="font-semibold text-cyan-300">Deployment cost:</span> {workflow.estimatedCost ? `${workflow.estimatedCost} HBAR` : 'Free'}</div>
              <div><span className="font-semibold text-cyan-300">Total Nodes:</span> {workflow.graphJson.nodes.length}</div>
              <div><span className="font-semibold text-cyan-300">Total Edges:</span> {workflow.graphJson.edges.length}</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {userId && userId === workflow.ownerUserId && (
              <button
                onClick={startDeployment}
                disabled={starting}
                className="px-6 py-3 rounded-xl border border-cyan-400/50 text-cyan-200 hover:bg-cyan-400/10 font-semibold transition disabled:opacity-50"
              >
                {starting ? 'Starting containers…' : workflow.workflowStatus === 'DEPLOYED' ? 'Redeploy' : 'Test and deploy'}
              </button>
            )}
            <button
              onClick={() => router.push(`/workflows/${workflow.id}/try`)}
              className="px-6 py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black font-semibold shadow-md transition"
            >
              Try it
            </button>
          </div>
        </header>

        {/* --- Graph --- */}
        <div className="flex justify-center">
          <div
            className="bg-[#071424] rounded-2xl p-4 shadow-lg border border-white/5"
            style={{
              height: 500,
              width: '85%',
              maxWidth: 1000,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <div className="w-full h-full">
              <ReactFlowProvider>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  fitView
                  attributionPosition="bottom-left"
                  nodeTypes={{ custom: CustomNode }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  panOnDrag={false}
                  panOnScroll={false}
                  zoomOnScroll={false}
                  zoomOnPinch={false}
                  zoomOnDoubleClick={false}
                >
                  <MiniMap
                    nodeStrokeWidth={1}
                    nodeColor={() => '#67F6FF'}
                    maskColor="rgba(10,11,20,0.7)"
                    style={{
                      width: 70,
                      height: 70,
                      background: '#0a0f1a',
                      border: '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '8px',
                    }}
                    pannable
                    zoomable
                  />
                  <Controls showInteractive />
                  <Background gap={16} size={1} color="rgba(255,255,255,0.03)" />
                </ReactFlow>
              </ReactFlowProvider>
            </div>
          </div>
        </div>

        {/* --- Node Summary --- */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-cyan-300">Nodes Summary</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {workflow.graphJson.nodes.map((n, i) => (
              <div key={i} className="p-4 rounded-xl bg-white/5 border border-white/10 text-sm leading-relaxed">
                <div className="font-semibold text-white mb-2 text-[15px]">{n.name}</div>
                <div className="text-gray-400">Node ID: <span className="font-mono text-gray-300">{n.id}</span></div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-xl font-bold text-cyan-300">Verifiable run history</h3>
            {runs[0]?.links?.topicUrl && (
              <a href={runs[0].links.topicUrl} target="_blank" rel="noreferrer" className="text-sm text-cyan-300 underline">
                Audit topic on HashScan
              </a>
            )}
          </div>
          {runs.length === 0 ? (
            <div className="text-gray-400 text-sm">No runs yet. Every run is hashed and anchored on the Hedera Consensus Service.</div>
          ) : (
            <div className="space-y-2">
              {runs.map(r => (
                <div key={r.id} className="rounded-xl bg-white/5 border border-white/10">
                  <button
                    onClick={() => setOpenRun(openRun === r.id ? null : r.id)}
                    className="w-full flex items-center justify-between gap-4 p-4 text-sm text-left"
                  >
                    <span className="text-gray-300">{new Date(r.createdAt).toLocaleString()}</span>
                    <span className={r.status === 'ok' ? 'text-green-300' : 'text-yellow-300'}>{r.status}</span>
                    <span className="text-gray-400">{r.mode}</span>
                    <span className="text-gray-400">{r.runtimeMs} ms</span>
                    <span className="font-mono text-xs text-gray-400">{r.hcsTopicId ? `HCS #${r.hcsSequence}` : 'not anchored'}</span>
                  </button>
                  {openRun === r.id && (
                    <div className="px-4 pb-4">
                      <RunProof
                        runId={r.id}
                        proof={{
                          inputHash: r.inputHash,
                          outputHash: r.outputHash,
                          runHash: r.runHash,
                          topicId: r.hcsTopicId ?? undefined,
                          sequenceNumber: r.hcsSequence ?? undefined,
                          transactionId: r.hcsTxId ?? undefined,
                          messageUrl: r.links?.messageUrl,
                          transactionUrl: r.links?.transactionUrl,
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* --- Edges --- */}
        <section className="space-y-4">
          <h3 className="text-xl font-bold text-cyan-300">Edges & Mappings</h3>
          <div className="space-y-4">
            {workflow.graphJson.edges.map((e: any, i: number) => (
              <div key={i} className="bg-gradient-to-r from-[#0a182a]/80 to-[#0c1c30]/80 p-5 rounded-xl border border-white/10 shadow-sm text-sm leading-relaxed">
                <div className="text-sm font-semibold text-cyan-300 mb-2">
                  {e.from} → {e.to}
                </div>
                <div className="space-y-1 text-gray-200">
                  <div><span className="font-semibold text-gray-300">Condition:</span> {e.condition ?? 'none'}</div>
                  <div><span className="font-semibold text-gray-300">Mapping:</span> <pre className="inline font-mono text-xs break-words">{JSON.stringify(e.mapping ?? {}, null, 2)}</pre></div>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <style jsx global>{`
        html, body { font-family: 'Inter', system-ui, sans-serif; }
        .react-flow__node-default { background: transparent !important; box-shadow: none !important; }
        .react-flow__controls, .react-flow__minimap { color: #e6f7ff; }
        .react-flow__controls button {
          background: rgba(255,255,255,0.05);
          color: #e6f7ff;
          border: 1px solid rgba(255,255,255,0.08);
        }
        .react-flow__minimap .react-flow__node {
          background: rgba(103,246,255,0.12);
          border: 1px solid rgba(103,246,255,0.3);
        }
        .react-flow__edge-text {
          color: #e6f7ff !important;
          background: rgba(0,0,0,0.35);
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 13px;
          white-space: normal !important;
          max-width: 420px;
          word-break: break-word;
        }
      `}</style>
    </div>
  );
}
