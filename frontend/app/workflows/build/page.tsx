'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import ReactFlow, {
  addEdge,
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  Connection,
  useNodesState,
  useEdgesState,
  ReactFlowProvider,
  Handle,
  Position,
  NodeProps,
  useReactFlow,
  OnSelectionChangeParams,
} from 'reactflow';
import 'reactflow/dist/style.css';
import RouteGuard from '../../../components/RouteGuard';
import { useUserStore } from '../../../store/useUserStore';

type Composition = {
  name: string;
  description: string;
  explanation: string;
  graphJson: {
    nodes: Array<{ id: string; name: string; toolId: string; purpose?: string; env: Record<string, string> }>;
    edges: Array<{ from: string; to: string; mapping: Record<string, string>; condition?: string }>;
  };
  secretsNeeded: Array<{ node: string; key: string }>;
  estimatedCostHbar: number;
  model: string;
};

/* ────────────────────── Types ────────────────────── */
interface Tool {
  id: string;
  name: string;
  description?: string;
  inputShape?: string;
  outputShape?: string;
  requiredEnv: string[];
}
interface WorkflowNodeData {
  label: string;
  toolId: string;
  toolName?: string;
  inputShape?: string;
  outputShape?: string;
  env: Record<string, string>;
}
interface WorkflowEdgeData {
  condition?: string;
  mapping?: Record<string, any>;
}
type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge<WorkflowEdgeData>;

/* ────────────────────── Custom Node ────────────────────── */
function CustomNode({ id, data }: NodeProps<WorkflowNodeData>) {
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
              {data.label ?? 'Untitled'}
            </div>
            <div className="mt-2 text-xs text-gray-400">
              ID: <span className="font-mono text-[11px] text-gray-200 break-words">{id}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-between text-xs text-gray-300">
          <div className="text-left max-w-[45%]">
            <div className="font-semibold text-cyan-300">Input Shape</div>
            <div className="break-words">{data.inputShape ?? 'Not specified'}</div>
          </div>
          <div className="text-right max-w-[45%]">
            <div className="font-semibold text-cyan-300">Output Shape</div>
            <div className="break-words">{data.outputShape ?? 'Not specified'}</div>
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Right} id={`out-${id}`} className="!bg-cyan-400/95 !w-3 !h-3" />
    </div>
  );
}
const nodeTypes = { custom: CustomNode };

/* ────────────────────── Inner Flow Component ────────────────────── */
function FlowCanvas() {
  const router = useRouter();
  const { project } = useReactFlow(); // inside provider
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const [tools, setTools] = useState<Tool[]>([]);
  const [loadingTools, setLoadingTools] = useState(true);
  const [workflowName, setWorkflowName] = useState('New Workflow');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<WorkflowEdgeData>([]);
  const [selectedElement, setSelectedElement] = useState<WorkflowNode | WorkflowEdge | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [tempTool, setTempTool] = useState<Tool | null>(null);
  const [tempPosition, setTempPosition] = useState<{ x: number; y: number } | null>(null);
  const [newNodeId, setNewNodeId] = useState('');
  const [newNodeName, setNewNodeName] = useState('');
  const [localCondition, setLocalCondition] = useState('');
  const [localMapping, setLocalMapping] = useState('');
  const [fixedUsageFee, setFixedUsageFee] = useState<number>(0);

  // NEW: sidebar visibility state
  const [leftVisible, setLeftVisible] = useState(true);
  const [rightVisible, setRightVisible] = useState(true);

  // Visibility toggles for env inputs (single state object, keys = env names)
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});

  const token = useUserStore(st => st.token);
  const [aiPrompt, setAiPrompt] = useState('');
  const [composing, setComposing] = useState(false);
  const [composition, setComposition] = useState<Composition | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const composeWithAi = async () => {
    if (!aiPrompt.trim()) return;
    setComposing(true);
    setAiError(null);
    try {
      const res = await axios.post<Composition>(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/ai/compose`,
        { prompt: aiPrompt },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const plan = res.data;
      const toolById = new Map(tools.map(t => [t.id, t]));
      setNodes(
        plan.graphJson.nodes.map((n, i) => {
          const tool = toolById.get(n.toolId);
          return {
            id: n.id,
            type: 'custom',
            position: { x: 80 + i * 380, y: 120 + (i % 2) * 60 },
            data: {
              label: n.name,
              toolId: n.toolId,
              toolName: tool?.name ?? n.name,
              inputShape: tool?.inputShape,
              outputShape: tool?.outputShape,
              env: n.env,
            },
          };
        }),
      );
      setEdges(
        plan.graphJson.edges.map((e, i) => ({
          id: `ai-${e.from}-${e.to}-${i}`,
          source: e.from,
          target: e.to,
          sourceHandle: `out-${e.from}`,
          targetHandle: `in-${e.to}`,
          type: 'smoothstep',
          animated: Boolean(e.condition),
          label: e.condition || undefined,
          data: { condition: e.condition ?? '', mapping: e.mapping },
        })),
      );
      setWorkflowName(plan.name);
      setWorkflowDesc(plan.description);
      setComposition(plan);
    } catch (err: any) {
      setAiError(err?.response?.data?.message ?? err.message);
    } finally {
      setComposing(false);
    }
  };

  /* ───── Load Tools ───── */
  useEffect(() => {
    const load = async () => {
      setLoadingTools(true);
      try {
        const res = await axios.get(`${process.env.NEXT_PUBLIC_BACKEND_URL}/tools`);
        setTools(res.data.tools);
        console.log('Loaded tools:', res.data.tools);
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingTools(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
  const data = {
    nodes,
    edges,
    // viewport: project.getViewport() // if you want to store zoom/pan
  };
  localStorage.setItem('myWorkflowGraph', JSON.stringify(data));
}, [nodes, edges]);

useEffect(() => {
  const saved = localStorage.getItem('myWorkflowGraph');
  if (saved) {
    const parsed = JSON.parse(saved);
    setNodes(parsed.nodes || []);
    setEdges(parsed.edges || []);
  }
}, [project, setNodes, setEdges]);

  useEffect(() => {
    // keep localCondition and localMapping in sync when selection changes
    if (selectedElement && 'source' in selectedElement) {
      setLocalCondition(selectedElement.data?.condition ?? '');
      setLocalMapping(JSON.stringify(selectedElement.data?.mapping ?? {}, null, 2));
    } else {
      setLocalCondition('');
      setLocalMapping('');
    }

    // initialize visibility keys for node env entries (don't recreate existing keys)
    if (selectedElement && !('source' in selectedElement)) {
      const env = selectedElement.data?.env ?? {};
      setVisibleKeys(prev => {
        const next = { ...prev };
        Object.keys(env).forEach(k => {
          if (!(k in next)) next[k] = false;
        });
        return next;
      });
    }
  }, [selectedElement]);

  const handleConditionChange = (v: string) => {
    setLocalCondition(v);

    // immediate update for small graphs
    setEdges(eds =>
      eds.map(e =>
        e.id === selectedElement?.id
          ? { ...e, data: { ...e.data, condition: v }, label: v || undefined, animated: !!v }
          : e
      )
    );
  };

  /* ───── Drag & Drop ───── */
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!reactFlowWrapper.current) return;
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const raw = e.dataTransfer.getData('application/reactflow');
      if (!raw) return;
      const { type, tool } = JSON.parse(raw);
      if (type !== 'tool') return;

      const pos = project({
        x: e.clientX - bounds.left,
        y: e.clientY - bounds.top,
      });

      setTempTool(tool);
      setTempPosition(pos);
      setNewNodeId('');
      setNewNodeName(tool.name);
      setShowAddModal(true);
    },
    [project]
  );

  /* ───── Add Node (modal) ───── */
  const handleAddNode = () => {
    if (!tempTool || !tempPosition || !newNodeId || !newNodeName) return;
    if (nodes.some(n => n.id === newNodeId)) {
      alert('Node ID must be unique');
      return;
    }
    const newNode: WorkflowNode = {
      id: newNodeId,
      type: 'custom',
      position: tempPosition,
      data: {
        label: newNodeName,
        toolId: tempTool.id,
        toolName: tempTool.name,
        inputShape: tempTool.inputShape,
        outputShape: tempTool.outputShape,
        env: tempTool.requiredEnv.reduce((acc, key) => ({ ...acc, [key]: '' }), {}),
      },
    };
    setNodes(nds => nds.concat(newNode));
    setShowAddModal(false);
    setTempTool(null);
    setTempPosition(null);
  };

  /* ───── Connections ───── */
  const onConnect = useCallback(
    (params: Connection) =>
      setEdges(eds =>
        addEdge(
          { ...params, type: 'smoothstep', animated: false, data: { condition: '', mapping: {} } },
          eds
        )
      ),
    [setEdges]
  );

  /* ───── Selection ───── */
  const onSelectionChange = useCallback((p: OnSelectionChangeParams) => {
    const { nodes: selN, edges: selE } = p;
    setSelectedElement(selN[0] || selE[0] || null);
  }, []);

  /* ───── Edit Helpers ───── */
  const updateNodeLabel = (v: string) => {
    if (!selectedElement || 'source' in selectedElement) return;
    setNodes(nds =>
      nds.map(n => (n.id === selectedElement.id ? { ...n, data: { ...n.data, label: v } } : n))
    );
    // reflect change in selectedElement too
    setSelectedElement(prev => (prev && !('source' in prev) && prev.id === prev.id ? { ...prev, data: { ...prev.data, label: v } } : prev));
  };

  const updateNodeEnv = (envKey: string, v: string) => {
    if (!selectedElement || 'source' in selectedElement) return;
    setNodes(nds => {
      const next = nds.map(n =>
        n.id === selectedElement.id
          ? { ...n, data: { ...n.data, env: { ...n.data.env, [envKey]: v } } }
          : n
      );
      // update selectedElement reference so inputs show fresh value
      const updatedNode = next.find(n => n.id === selectedElement.id) ?? null;
      if (updatedNode) setSelectedElement(updatedNode);
      return next;
    });
  };

  const updateEdgeCondition = (v: string) => {
    if (!selectedElement || !('source' in selectedElement)) return;
    setEdges(eds =>
      eds.map(e =>
        e.id === selectedElement.id
          ? { ...e, data: { ...e.data, condition: v }, label: v || undefined, animated: !!v }
          : e
      )
    );
  };

  const updateEdgeMapping = (txt: string) => {
    if (!selectedElement || !('source' in selectedElement)) return;
    try {
      const mapping = JSON.parse(txt);
      setEdges(eds =>
        eds.map(e => (e.id === selectedElement.id ? { ...e, data: { ...e.data, mapping } } : e))
      );
      // also refresh the selectedElement reference with updated mapping
      setSelectedElement(prev => {
        if (!prev || !('source' in prev)) return prev;
        return { ...prev, data: { ...prev.data, mapping } };
      });
    } catch {
      alert('Invalid JSON');
    }
  };

  /* ───── Save ───── */
/* ───── Save and Auto-Test Workflow ───── */
const saveWorkflow = async () => {
  const graphJson = {
    nodes: nodes.map(n => ({
      id: n.id,
      name: n.data.label,
      toolId: n.data.toolId,
      env: n.data.env, // include env vars for each node
    })),
    edges: edges.map(e => ({
      from: e.source,
      to: e.target,
      condition: e.data?.condition,
      mapping: e.data?.mapping,
    })),
  };

  try {
    console.log(
      {
        name: workflowName,
        description: workflowDesc,
        fixedUsageFee, // numeric, optional
        graphJson,     // includes env vars
      }
    )
    const tokenString = localStorage.getItem('access_token');
    let token = '';
    if (tokenString) {
      try {
        const parsed = JSON.parse(tokenString);
        token = parsed.state?.token ?? '';
      } catch (e) {
        console.error('Failed to parse access_token from localStorage', e);
      }
    }
    console.log(token);
    const res = await axios.post(
      `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflows`,
      {
        name: workflowName,
        description: workflowDesc,
        fixedUsageFee, // numeric, optional
        graphJson,     // includes env vars
      },
      {
        headers: {
          Authorization: `Bearer ${token}`, // adapt to your auth storage
        },
      }
    );

    // backend returns { success: true, workflow, test }
    const { workflow, test } = res.data;

    // test.instance is created privateWorkflowInstance id (per your backend)
    const instanceId = test?.instance;
    if (instanceId) {
      // redirect to testing UI
      router.push(`/workflows/testing/${instanceId}`);
      return;
    }

    // fallback: navigate to workflows list if instance not present
    alert('Workflow created but no test instance returned. Redirecting to /workflows');
    router.push('/workflows');
  } catch (e: any) {
    console.error(e);
    alert(`❌ Error:\n${e.response?.data?.message || e.message}`);
  }
};


  return (
    <RouteGuard requireLogin>
    <div className="flex min-h-screen bg-[#050b15] text-white font-inter">
      {/* Left sidebar (no longer fixed). Width toggles between w-80 and w-0 */}
      <aside className={`flex-none transition-all duration-300 ${leftVisible ? 'w-80 p-6' : 'w-0 p-0'} border-r border-white/10 bg-[#071424] overflow-hidden`}>
        {leftVisible && (
          <div className="h-full overflow-y-auto">
            <h2 className="text-2xl font-bold text-cyan-300 mb-4">Available Tools</h2>
            {loadingTools ? (
              <p className="text-gray-400">Loading…</p>
            ) : (
              <div className="space-y-3">
                {tools.map(t => (
                  <div
                    key={t.id}
                    className="p-4 rounded-xl bg-white/5 border border-white/10 cursor-grab"
                    draggable
                    onDragStart={e => {
                      e.dataTransfer.setData(
                        'application/reactflow',
                        JSON.stringify({ type: 'tool', tool: { id: t.id, name: t.name, inputShape: t.inputShape, outputShape: t.outputShape, requiredEnv: t.requiredEnv } })
                      );
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                  >
                    <div className="font-semibold">{t.name}</div>
                    <div className="text-sm text-gray-400">{t.description ?? '–'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      {/* Main area grows to fill available space. Header + canvas use flex-col so canvas expands when sidebars hide */}
      <main className="flex-1 p-10 flex flex-col">
        <header className="flex items-center justify-between">
          <div className="space-y-2">
            <input
              type="text"
              value={workflowName}
              onChange={e => setWorkflowName(e.target.value)}
              className="text-4xl font-bold bg-transparent border-none focus:outline-none"
            />
            <textarea
              value={workflowDesc}
              onChange={e => setWorkflowDesc(e.target.value)}
              placeholder="Workflow description"
              className="w-full bg-transparent border-none focus:outline-none text-gray-300 resize-none"
            />
            <div className="flex items-center gap-2 text-gray-300 mt-2">
  <label className="text-sm font-semibold text-cyan-300">Fixed Usage Fee (USD):</label>
  <input
    type="number"
    step="0.01"
    min="0"
    value={fixedUsageFee}
    onChange={e => setFixedUsageFee(parseFloat(e.target.value) || 0)}
    className="w-24 bg-transparent border-b border-white/10 py-1 px-2 focus:outline-none text-white"
  />
</div>
          </div>
          <button
            onClick={saveWorkflow}
            className="px-6 py-3 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-black text-semibold shadow-md transition"
          >
            Test
          </button>
        </header>

        <section className="mt-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-cyan-300">Compose with AI</div>
            <div className="text-xs text-gray-400">Gemini Flash Lite picks tools from the marketplace and wires them for you</div>
          </div>
          <div className="flex gap-3">
            <textarea
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) composeWithAi();
              }}
              placeholder="e.g. Translate customer emails from Arabic or French to English, then tag them as billing, outage or feedback"
              className="flex-1 h-16 bg-[#071424] border border-white/10 rounded-lg p-3 text-sm resize-none focus:outline-none focus:border-cyan-400/50"
            />
            <button
              onClick={composeWithAi}
              disabled={composing || !aiPrompt.trim() || loadingTools}
              className="px-5 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-black font-semibold disabled:opacity-50"
            >
              {composing ? 'Composing…' : 'Compose'}
            </button>
          </div>
          {aiError && <div className="text-sm text-red-300">{aiError}</div>}
          {composition && (
            <div className="text-sm text-gray-300 space-y-1">
              <div>{composition.explanation}</div>
              <div className="text-xs text-gray-400">
                Estimated deployment cost {composition.estimatedCostHbar} HBAR · {composition.model}
                {composition.secretsNeeded.length > 0 &&
                  ` · Fill in ${Array.from(new Set(composition.secretsNeeded.map(x => x.key))).join(', ')} on each node before testing`}
              </div>
            </div>
          )}
        </section>

        {/* React-Flow Canvas: make it flex-1 so it expands/shrinks with layout */}
        <div className="flex-1 mt-6 border border-white/10 rounded-2xl overflow-hidden" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            fitView
            attributionPosition="bottom-left"
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
            <Controls />
            <Background gap={16} size={1} color="rgba(255,255,255,0.03)" />
          </ReactFlow>
        </div>
      </main>

      {/* Right sidebar (no longer fixed). Width toggles */}
      {/* Right sidebar */}
      <aside
        className={`flex-none transition-all duration-300 ${
          rightVisible ? 'w-80 p-6' : 'w-0 p-0'
        } border-l border-white/10 bg-[#071424] overflow-hidden`}
      >
        {rightVisible && (
          <div className="h-full overflow-y-auto">
            <h2 className="text-2xl font-bold text-cyan-300 mb-6">Properties</h2>

            {selectedElement ? (
              /* ─────────────── Edge Properties ─────────────── */
              'source' in selectedElement ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      From → To
                    </label>
                    <input
                      value={`${selectedElement.source} → ${selectedElement.target}`}
                      disabled
                      className="w-full bg-transparent border-b border-white/10 py-2"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Condition
                    </label>
                    <input
                      value={localCondition}
                      onChange={(e) => setLocalCondition(e.target.value)}
                      onBlur={() => updateEdgeCondition(localCondition)}
                      className="w-full bg-transparent border-b border-white/10 py-2 focus:outline-none"
                      placeholder="e.g. closest_category === 'technology'"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Input (JSON)
                    </label>
                    <textarea
                      value={localMapping}
                      onChange={(e) => setLocalMapping(e.target.value)}
                      onBlur={() => updateEdgeMapping(localMapping)}
                      className="w-full h-40 bg-transparent border border-white/10 p-2 rounded focus:outline-none font-mono text-sm"
                      placeholder={`{
  "email": "kingdomgd4@gmail.com",
  "message": "Non-tech category: {{closest_category}}"
}`}
                    />
                    <p className="text-xs text-gray-400 mt-1">{'Use {{variable}} for outputs from source node.'}</p>
                  </div>
                </div>
              ) : (
                /* ─────────────── Node Properties ─────────────── */
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Node ID
                    </label>
                    <input
                      value={selectedElement.id}
                      disabled
                      className="w-full bg-transparent border-b border-white/10 py-2"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Name
                    </label>
                    <input
                      value={selectedElement.data.label}
                      onChange={(e) => updateNodeLabel(e.target.value)}
                      className="w-full bg-transparent border-b border-white/10 py-2 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Tool
                    </label>
                    <input
                      value={selectedElement.data.toolName ?? 'Unknown'}
                      disabled
                      className="w-full bg-transparent border-b border-white/10 py-2"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-300">
                      Environment Variables
                    </label>
                    {Object.entries(selectedElement.data.env ?? {}).map(
                      ([key, value]) => (
                        <div key={key} className="mt-2">
                          <label className="block text-xs text-gray-400">{key}</label>
                          <div className="relative">
                            <input
                              type={visibleKeys[key] ? 'text' : 'password'}
                              value={value}
                              onChange={(e) => updateNodeEnv(key, e.target.value)}
                              className="w-full bg-transparent border-b border-white/10 py-2 pr-8 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setVisibleKeys((prev) => ({
                                  ...prev,
                                  [key]: !prev[key],
                                }))
                              }
                              className="absolute right-0 top-1/2 -translate-y-1/2 px-2 text-gray-400 hover:text-cyan-300"
                            >
                              {visibleKeys[key] ? (
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  className="h-4 w-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={1.5}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                  />
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                  />
                                </svg>
                              ) : (
                                <svg
                                  xmlns="http://www.w3.org/2000/svg"
                                  className="h-4 w-4"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                  strokeWidth={1.5}
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M3 3l18 18M9.88 9.88A3 3 0 0115 12m3.42 3.42A9.99 9.99 0 012.458 12 9.963 9.963 0 016.58 8.58m4.42-.58a9.953 9.953 0 017.716 3.716"
                                  />
                                </svg>
                              )}
                            </button>
                          </div>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )
            ) : (
              <p className="text-gray-400">Select a node or edge to edit.</p>
            )}
          </div>
        )}
      </aside>

      {/* Floating toggle buttons (always visible). These are small fixed buttons to show/hide sidebars */}
      <button
        aria-label={leftVisible ? 'Hide left panel' : 'Show left panel'}
        onClick={() => setLeftVisible(v => !v)}
        className="fixed left-2 top-1/2 transform -translate-y-1/2 z-50 p-2 rounded-md bg-white/5 hover:bg-white/8 border border-white/10"
      >
        {leftVisible ? '‹' : '›'}
      </button>

      <button
        aria-label={rightVisible ? 'Hide right panel' : 'Show right panel'}
        onClick={() => setRightVisible(v => !v)}
        className="fixed right-2 top-1/2 transform -translate-y-1/2 z-50 p-2 rounded-md bg-white/5 hover:bg-white/8 border border-white/10"
      >
        {rightVisible ? '›' : '‹'}
      </button>

      {/* ── ADD NODE MODAL ── */}
      {showAddModal && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50">
          <div className="bg-[#071424] p-8 rounded-2xl border border-white/10 space-y-4 w-96">
            <h3 className="text-xl font-bold text-cyan-300">Add Node</h3>
            <div>
              <label className="block text-sm font-semibold text-gray-300">Node ID (unique)</label>
              <input
                value={newNodeId}
                onChange={e => setNewNodeId(e.target.value)}
                className="w-full bg-transparent border-b border-white/10 py-2 focus:outline-none"
                placeholder="e.g. classifier_node"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-300">Node Name</label>
              <input
                value={newNodeName}
                onChange={e => setNewNodeName(e.target.value)}
                className="w-full bg-transparent border-b border-white/10 py-2 focus:outline-none"
                placeholder="e.g. Text Classifier"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-gray-300">Cancel</button>
              <button onClick={handleAddNode} className="px-4 py-2 bg-cyan-400 text-black rounded-xl">Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </RouteGuard>
  );
}

/* ────────────────────── Page Component (wraps provider) ────────────────────── */
export default function CreateWorkflowPage() {
  return (
    <ReactFlowProvider>
      <FlowCanvas />
      {/* Global styles – keep them here or in a layout file */}
      <style jsx global>{`
        html,
        body {
          font-family: 'Inter', system-ui, sans-serif;
        }
        .react-flow__node-default {
          background: transparent !important;
          box-shadow: none !important;
        }
        .react-flow__controls,
        .react-flow__minimap {
          color: #e6f7ff;
        }
        .react-flow__controls button {
          background: rgba(255, 255, 255, 0.05);
          color: #e6f7ff;
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .react-flow__minimap .react-flow__node {
          background: rgba(103, 246, 255, 0.12);
          border: 1px solid rgba(103, 246, 255, 0.3);
        }
        .react-flow__edge-text {
          color: #e6f7ff !important;
          background: rgba(0, 0, 0, 0.35);
          padding: 6px 10px;
          border-radius: 8px;
          font-size: 13px;
          white-space: normal !important;
          max-width: 420px;
          word-break: break-word;
        }
      `}</style>
    </ReactFlowProvider>
  );
}
