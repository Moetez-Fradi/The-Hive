'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import axios from 'axios';
import { useUserStore } from '../../../../store/useUserStore';
import RunProof, { Proof } from '../../../../components/RunProof';

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:3001') as string;

type Workflow = {
  id: string;
  name?: string;
  description?: string;
  graphJson?: any;
  usageUrl?: string | null;
  workflowStatus?: string;
  owner?: { id: string; displayName?: string | null };
};

type NodeResult = { status: string; output?: any; input?: any; error?: any; ms?: number };
type RunResponse = { runId: string; status: string; mode: string; runtimeMs: number; results: Record<string, NodeResult>; proof: Proof | null };

function parseShape(raw: unknown): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default function WorkflowTryPage() {
  const params = useParams();
  const router = useRouter();
  const workflowId = (params as any).id as string;
  const token = useUserStore(s => s.token);

  const [loading, setLoading] = useState(true);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputShape, setInputShape] = useState<Record<string, any> | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [rawJson, setRawJson] = useState('{}');
  const [submitting, setSubmitting] = useState(false);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<{ message: string; paymentId?: string } | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    (async () => {
      setLoading(true);
      try {
        const wres = await axios.get<Workflow>(`${API_BASE}/workflows/${workflowId}`);
        const wf = wres.data;
        setWorkflow(wf);
        const firstNode = wf.graphJson?.nodes?.[0];
        let shape: Record<string, any> | null = null;
        if (firstNode?.toolId) {
          try {
            const tres = await axios.get(`${API_BASE}/tools/${firstNode.toolId}`);
            shape = parseShape(tres.data.inputShape);
          } catch {}
        }
        setInputShape(shape);
        if (shape) setFormValues(Object.fromEntries(Object.keys(shape).map(k => [k, ''])));
      } catch (err: any) {
        setError(err?.response?.data?.message || err?.message || 'Failed to load workflow');
      } finally {
        setLoading(false);
      }
    })();
  }, [workflowId]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!workflow) return;
    if (!token) {
      router.push('/login');
      return;
    }

    let input: any;
    if (inputShape) input = { ...formValues };
    else {
      try {
        input = JSON.parse(rawJson);
      } catch {
        setRunError({ message: 'Invalid JSON payload' });
        return;
      }
    }

    setSubmitting(true);
    setRun(null);
    setRunError(null);
    try {
      const resp = await axios.post<RunResponse>(
        `${API_BASE}/workflows/${workflow.id}/run`,
        { input },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setRun(resp.data);
    } catch (err: any) {
      const data = err?.response?.data;
      const message = typeof data?.message === 'string' ? data.message : data?.message?.message ?? err.message;
      setRunError({ message, paymentId: data?.paymentId ?? data?.message?.paymentId });
    } finally {
      setSubmitting(false);
    }
  };

  if (!workflowId) return <div className="p-8">No workflow id provided</div>;
  if (loading) return <div className="p-8">Loading…</div>;
  if (error) return <div className="p-8 text-red-400">Error: {error}</div>;
  if (!workflow) return <div className="p-8">Workflow not found</div>;

  const deployed = workflow.workflowStatus === 'DEPLOYED' && Boolean(workflow.usageUrl);
  const nodeName = (id: string) => workflow.graphJson?.nodes?.find((n: any) => n.id === id)?.name ?? id;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-start justify-between mb-6 gap-6">
        <div>
          <h1 className="text-5xl font-bold">{workflow.name ?? workflow.id}</h1>
          {workflow.description && <div className="text-gray-400 mt-4">{workflow.description}</div>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => router.push(`/workflows/${workflow.id}`)} className="px-3 py-2 border border-white/10 rounded text-sm">
            Back to workflow
          </button>
          {workflow.owner?.id && (
            <button onClick={() => router.push(`/users/${workflow.owner!.id}`)} className="px-3 py-2 bg-green-600 text-black rounded text-sm">
              Builder&apos;s profile
            </button>
          )}
        </div>
      </div>

      {!deployed && (
        <div className="mb-4 p-4 bg-yellow-900/20 border border-yellow-800 text-yellow-200 rounded">
          This workflow is not deployed yet. The owner has to deploy it and pay the tool creators in HBAR before it can run.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {inputShape ? (
          <div className="space-y-3">
            <h3 className="font-semibold">Inputs</h3>
            {Object.keys(inputShape).map(key => (
              <div key={key} className="flex flex-col">
                <label className="block text-sm text-gray-300 mb-1">{key}</label>
                {key === 'text' ? (
                  <textarea
                    value={formValues[key] ?? ''}
                    onChange={e => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full h-28 bg-[#071424] border border-white/6 rounded p-2 font-mono"
                    placeholder="Paste a customer message in any language"
                  />
                ) : (
                  <input
                    type="text"
                    value={formValues[key] ?? ''}
                    onChange={e => setFormValues(prev => ({ ...prev, [key]: e.target.value }))}
                    className="w-full bg-[#071424] border border-white/6 rounded p-2"
                    placeholder={String(inputShape[key] ?? '')}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div>
            <label className="block text-sm text-gray-300 mb-1">Raw JSON input</label>
            <textarea
              value={rawJson}
              onChange={e => setRawJson(e.target.value)}
              className="w-full h-56 bg-[#071424] border border-white/6 rounded p-2 font-mono"
            />
          </div>
        )}

        <button type="submit" disabled={!deployed || submitting} className="px-4 py-2 bg-cyan-400 text-black rounded font-semibold disabled:opacity-50">
          {submitting ? 'Running…' : 'Run workflow'}
        </button>
      </form>

      {runError && (
        <div className="mt-6 p-4 rounded border border-red-800 bg-red-900/20 text-red-200">
          {runError.message}
          {runError.paymentId && (
            <button onClick={() => router.push(`/workflows/pay/${runError.paymentId}`)} className="ml-3 underline text-yellow-300">
              Pay deployment
            </button>
          )}
        </div>
      )}

      {run && (
        <div className="mt-8 space-y-4">
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <span className={`px-2 py-0.5 rounded font-semibold ${run.status === 'ok' ? 'bg-green-500/20 text-green-300' : 'bg-yellow-500/20 text-yellow-300'}`}>
              {run.status}
            </span>
            <span>{run.mode === 'decentralized' ? 'Executed on renter nodes' : 'Executed on the Hive runner'}</span>
            <span>{run.runtimeMs} ms</span>
          </div>

          {Object.entries(run.results).map(([id, r]) => (
            <div key={id} className="p-3 bg-[#071424] border border-white/6 rounded">
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>{nodeName(id)}</span>
                <span>
                  {r.status}
                  {r.ms != null ? ` · ${r.ms} ms` : ''}
                </span>
              </div>
              <pre className="font-mono text-sm whitespace-pre-wrap">{JSON.stringify(r.output ?? r.error ?? null, null, 2)}</pre>
            </div>
          ))}

          <RunProof runId={run.runId} proof={run.proof} />
        </div>
      )}
    </div>
  );
}
