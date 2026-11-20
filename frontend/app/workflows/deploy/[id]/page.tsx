// app/(whatever)/DeployWithTestsPage.tsx  (replace your existing file)
'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import axios from 'axios';

/* ------------------- Types ------------------- */
type PrivateWorkflowInstance = {
  id: string;
  graphJson: any;
  ownerUserId: string;
  usageUrl?: string | null;
  createdAt: string;
  workflowId?: string | null;
};

type Tool = {
  id: string;
  name: string;
  description?: string;
  inputShape?: string;
  outputShape?: string;
  requiredEnv?: string[];
};

type Workflow = {
  id: string;
  graphJson: any;
  name?: string;
  description?: string;
};

type Payout = {
  paymentId?: string;
  receiver: string;
  amount: number;
  toolId?: string;
  toolName?: string;
};

type DeployResponse = {
  instanceId?: string;
  usageUrl?: string;
  runnerReport?: any;
  mapping?: any;
  receipt?: Payout[];
  paymentId?: string;
};

/* ------------------- Helper: tolerant parser ------------------- */
function tryParseToolInputShape(raw: string | undefined | null): any | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  try {
    let s = raw.trim();
    s = s.replace(/`/g, '"');
    s = s.replace(/([{,]\s*)([A-Za-z0-9_\-$]+)\s*:/g, '$1"$2":');
    s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
    s = s.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(s);
  } catch (e) {
    console.warn('Could not parse tool inputShape:', raw);
    return null;
  }
}

/* ------------------- Component ------------------- */
export default function DeployWithTestsPage() {
  const params = useParams();
  const instanceId = params?.id;
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [instance, setInstance] = useState<PrivateWorkflowInstance | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [toolInputShape, setToolInputShape] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const [tests, setTests] = useState<Array<Record<string, any>>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<DeployResponse | null>(null);
  const [responseText, setResponseText] = useState<string | null>(null);

  useEffect(() => {
    if (!instanceId) return;

    const fetch = async () => {
      setLoading(true);
      setError(null);
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

      try {
        const backend_url = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';
        console.log(backend_url)
        const instRes = await axios.get<PrivateWorkflowInstance>(
          `${backend_url}/workflow-instances/${instanceId}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} }
        );
        const inst = instRes.data;
        setInstance(inst);

        let wf: Workflow | null = null;
        if (inst.workflowId) {
          try {
            const wfRes = await axios.get<Workflow>(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflows/${inst.workflowId}`,
              { headers: token ? { Authorization: `Bearer ${token}` } : {} }
            );
            wf = wfRes.data;
            setWorkflow(wf);
          } catch (err) {
            console.warn('Could not fetch workflow metadata', err);
          }
        }

        const sourceGraph = wf?.graphJson ?? inst.graphJson;
        const firstNode = sourceGraph?.nodes?.[0];

        let inputShape: any = null;
        if (firstNode?.toolId) {
          try {
            const toolRes = await axios.get<Tool>(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/tools/${firstNode.toolId}`,
              { headers: token ? { Authorization: `Bearer ${token}` } : {} }
            );
            inputShape = toolRes.data.inputShape ?? null;
            if (typeof inputShape === 'string') {
              const parsed = tryParseToolInputShape(inputShape);
              if (parsed !== null) inputShape = parsed;
            }
          } catch (err) {
            console.warn('Could not fetch tool; falling back to node-level shape', err);
          }
        }

        if (!inputShape) {
          let shape =
            firstNode?.inputShape ??
            firstNode?.data?.inputShape ??
            firstNode?.input_shape ??
            null;
          if (typeof shape === 'string') {
            const parsed = tryParseToolInputShape(shape);
            if (parsed !== null) shape = parsed;
          }
          inputShape = shape;
        }

        setToolInputShape(inputShape);

        if (tests.length === 0) {
          if (inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape)) {
            const template: Record<string, any> = {};
            Object.keys(inputShape).forEach(k => (template[k] = ''));
            setTests([template]);
          } else if (inputShape && typeof inputShape === 'string') {
            setTests([{ input: '' }]);
          } else {
            setTests([{}]);
          }
        }
      } catch (err: any) {
        console.error(err);
        setError(err?.response?.data?.message || err?.message || 'Failed to load instance');
      } finally {
        setLoading(false);
      }
    };

    fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId]);

  /* ---------- Test helpers (unchanged) ---------- */
  const addTest = () => {
    if (toolInputShape && typeof toolInputShape === 'object' && !Array.isArray(toolInputShape)) {
      const template: Record<string, any> = {};
      Object.keys(toolInputShape).forEach(k => (template[k] = ''));
      setTests(prev => [...prev, template]);
    } else if (toolInputShape && typeof toolInputShape === 'string') {
      setTests(prev => [...prev, { input: '' }]);
    } else {
      setTests(prev => [...prev, {}]);
    }
  };

  const removeTest = (index: number) => {
    setTests(prev => prev.filter((_, i) => i !== index));
  };

  const updateTestField = (testIndex: number, key: string, value: any) => {
    setTests(prev => prev.map((t, i) => (i === testIndex ? { ...t, [key]: value } : t)));
  };

  /* ---------- Deploy handler (mostly unchanged) ---------- */
  const handleDeploy = async (e?: React.FormEvent) => {
    e?.preventDefault?.();
    if (!instance) {
      alert('Missing instance data');
      return;
    }
    if (!instance.workflowId) {
      alert('Instance does not reference a workflow id');
      return;
    }

    const builtTests = tests.map(t => {
      if (toolInputShape && typeof toolInputShape === 'object' && !Array.isArray(toolInputShape)) {
        return { input: { ...t } };
      } else if (toolInputShape && typeof toolInputShape === 'string') {
        return { input: { value: t.input ?? '' } };
      } else {
        return { input: t };
      }
    });

    const payload = {
      graphJson: instance.graphJson,
      tests: builtTests,
    };

    const tokenString = localStorage.getItem('access_token');
    let token = '';
    if (tokenString) {
      try {
        const parsed = JSON.parse(tokenString);
        token = parsed.state?.token ?? '';
      } catch (err) {
        console.warn('Failed to parse access_token', err);
      }
    }

    setSubmitting(true);
    setResponse(null);
    setResponseText(null);

    try {
      const res = await axios.post<DeployResponse>(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflows/${instance.workflowId}/deploy`,
        payload,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }
      );

      setResponse(res.data);
      setResponseText(JSON.stringify(res.data, null, 2));
      alert('Deploy + tests submitted successfully');

      console.log(res.data)

      // if server returned payouts, keep them in state and show pay UI (below)
    } catch (err: any) {
      console.error('Deploy failed', err);
      const message = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
      setResponseText(message);
      alert('Deploy failed — check console / response below');
    } finally {
      setSubmitting(false);
    }
  };

  /* ---------- Payment UI helpers ---------- */
  const computeTotal = (payouts?: Payout[]) => {
    if (!payouts || payouts.length === 0) return 0;
    return payouts.reduce((s, p) => s + Number(p.amount || 0), 0);
  };

  const handlePayClick = (deployResp: DeployResponse | null) => {
    console.log('handlePayClick', deployResp);
    // deployResp?.instanceId = 
    // if (!deployResp?.instanceId) {
    //   alert('Missing deploy instance id, cannot pay');
    //   return;
    // }
    if (!deployResp) {
      alert('Missing deploy response, cannot pay');
      return;
    }
    // store deploy receipt so the payment page can use it (server may also support fetching by instanceId)
    try {
      sessionStorage.setItem(`payment_receipt_${deployResp.paymentId}`, JSON.stringify(deployResp));
    } catch (e) {
      console.warn('failed to store payment receipt in sessionStorage', e);
    }
    // route to payment page — page will load the receipt from sessionStorage or fallback to backend fetch
    router.push(`/workflows/pay/${deployResp.paymentId}`);
  };

  /* ---------- Render ---------- */
  if (!instanceId) return <div className="p-6">No instance id provided</div>;
  if (loading) return <div className="p-6">Loading…</div>;
  if (error) return <div className="p-6 text-red-400">Error: {error}</div>;
  if (!instance) return <div className="p-6">Instance not found</div>;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Deploy workflow & run tests</h1>
          <div className="text-sm text-gray-400">
            Instance: <span className="font-mono">{instance.id}</span>
            <br />
            {instance.workflowId && (
              <> Workflow: <span className="font-mono">{instance.workflowId}</span></>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => router.push(`/workflows/testing/${instance.id}`)}
            className="px-3 py-2 border border-white/10 rounded text-sm"
          >
            Back to testing
          </button>
        </div>
      </div>

      <div className="mb-6 p-4 bg-[#071424] border border-white/6 rounded">
        <div className="text-sm text-gray-300 mb-2">Graph preview (first node):</div>
        <pre className="font-mono text-sm whitespace-pre-wrap">{JSON.stringify(instance.graphJson?.nodes?.[0] ?? {}, null, 2)}</pre>
      </div>

      <form onSubmit={handleDeploy} className="space-y-4">
        {/* --- tests UI (unchanged) --- */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Tests</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addTest}
              className="px-3 py-1 bg-green-600 text-black rounded flex items-center gap-2"
            >
              <span className="text-lg font-bold leading-none">+</span>
              <span className="text-sm">Add test</span>
            </button>
            <button
              type="button"
              onClick={() => setTests([])}
              className="px-3 py-1 border rounded text-sm"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="space-y-4">
          {tests.map((test, idx) => (
            <div key={idx} className="p-4 bg-[#0b1620] border border-white/6 rounded">
              <div className="flex items-start justify-between">
                <div className="font-semibold">Test #{idx + 1}</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTests(prev => {
                        const copy = [...prev];
                        copy.splice(idx + 1, 0, JSON.parse(JSON.stringify(prev[idx] || {})));
                        return copy;
                      });
                    }}
                    className="px-2 py-1 border rounded text-sm"
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTest(idx)}
                    className="px-2 py-1 border rounded text-sm text-red-300"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div className="mt-3 space-y-3">
                {toolInputShape && typeof toolInputShape === 'object' && !Array.isArray(toolInputShape) ? (
                  Object.keys(toolInputShape).map((k) => (
                    <div key={k}>
                      <label className="block text-sm text-gray-300 mb-1">{k}</label>

                      {k === 'text' ? (
                        <textarea
                          value={test[k] ?? ''}
                          onChange={(e) => updateTestField(idx, k, e.target.value)}
                          placeholder={typeof toolInputShape[k] === 'string' ? toolInputShape[k] : ''}
                          className="w-full bg-[#071424] border border-white/6 rounded p-2 font-mono h-28"
                        />
                      ) : (
                        <input
                          value={test[k] ?? ''}
                          onChange={(e) => updateTestField(idx, k, e.target.value)}
                          placeholder={typeof toolInputShape[k] === 'string' ? toolInputShape[k] : ''}
                          className="w-full bg-[#071424] border border-white/6 rounded p-2"
                        />
                      )}
                    </div>
                  ))
                ) : toolInputShape && typeof toolInputShape === 'string' ? (
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Value</label>
                    <textarea
                      value={test.input ?? ''}
                      onChange={(e) => updateTestField(idx, 'input', e.target.value)}
                      className="w-full bg-[#071424] border border-white/6 rounded p-2 h-28 font-mono"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm text-gray-300 mb-1">Raw JSON</label>
                    <textarea
                      value={JSON.stringify(test ?? {}, null, 2)}
                      onChange={(e) => {
                        try {
                          const parsed = JSON.parse(e.target.value);
                          setTests(prev => prev.map((t, i) => (i === idx ? parsed : t)));
                        } catch {
                          // ignore invalid JSON while typing
                        }
                      }}
                      className="w-full bg-[#071424] border border-white/6 rounded p-2 h-28 font-mono"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-cyan-400 text-black rounded"
          >
            {submitting ? 'Deploying…' : 'Deploy + Run Tests'}
          </button>

          <button
            type="button"
            onClick={() => {
              setTests(prev => prev.map((t, i) => (i === 0 ? { ...t, text: 'i love technology!' } : t)));
            }}
            className="px-4 py-2 border rounded border-white/10 text-white"
          >
            Fill example
          </button>
        </div>
      </form>

      {/* show server response */}
      {responseText && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">Server response</h3>
          <pre className="bg-[#071424] border border-white/6 rounded p-4 font-mono whitespace-pre-wrap max-h-72 overflow-auto">
            {responseText}
          </pre>
        </div>
      )}

      {/* show parsed response details */}
      {response && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">Response details</h3>
          <div className="bg-[#071424] border border-white/6 rounded p-4">
            <div className="text-sm text-gray-300">Usage URL: {response.usageUrl ?? response.runnerReport?.workflowUsageUrl ?? '-'}</div>
            {response.mapping && (
              <div className="mt-2 text-sm text-gray-300">Mapping: <pre className="font-mono">{JSON.stringify(response.mapping, null, 2)}</pre></div>
            )}
            {response.runnerReport && (
              <div className="mt-2 text-sm text-gray-300">Runner report: <pre className="font-mono">{JSON.stringify(response.runnerReport, null, 2)}</pre></div>
            )}
          </div>

          {/* ---------------- Payment summary ---------------- */}
          {response.receipt && response.receipt.length > 0 && (
            <div className="mt-6 p-4 bg-[#071424] border border-white/6 rounded">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm text-gray-300">Payments required</div>
                  <div className="text-lg font-mono">{response.receipt.length} recipients</div>
                </div>
                <div className="text-right">
                  <div className="text-sm text-gray-300">Total (HBAR)</div>
                  <div className="text-2xl font-bold">{computeTotal(response.receipt)}</div>
                </div>
              </div>

              <div className="mt-4">
                <ul className="space-y-2">
                  {response.receipt.map((p, i) => (
                    <li key={i} className="flex items-center justify-between p-2 bg-[#0b1620] rounded">
                      <div>
                        <div className="font-semibold">{p.toolName ?? p.receiver}</div>
                        <div className="text-xs text-gray-400">{p.receiver}</div>
                      </div>
                      <div className="font-mono">{p.amount} HBAR</div>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => handlePayClick(response)}
                  className="px-4 py-2 bg-yellow-400 text-black rounded"
                >
                  Pay now
                </button>

               
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
