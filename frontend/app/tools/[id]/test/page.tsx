'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

type Tool = {
  id: string;
  name: string;
  description?: string;
  dockerImageUrl?: string;
  usagePrice?: number;
  status?: string;
  inputShape?: string | object | null;
  outputShape?: string | object | null;
  requiredEnv?: string[];
};

type TestInstance = {
  id: string;
  usageUrl?: string | null;
  status?: string;
};

type TestResult = {
  success?: boolean;
  instance?: TestInstance | null;
  testReport?: any;
  reason?: string;
  details?: any;
};

const API_BASE = 'http://localhost:3001';

const getAuthToken = () => {
  const tokenString = localStorage.getItem('access_token');
  let token = '';
  if (tokenString) {
    try {
      const parsed = JSON.parse(tokenString);
      token = parsed.state?.token ?? '';
    } catch {}
  }
  return token;
};

function tryParseToolInputShape(raw: string | undefined | null): any | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  try {
    let s = raw.trim();
    s = s.replace(/`/g, '"');
    s = s.replace(/([{,]\s*)([A-Za-z0-9_\-$]+)\s*:/g, '$1"$2":');
    s = s.replace(/:\s*'([^']*)'/g, ': "$1"');
    s = s.replace(/,(\s*[}\]])/g, '$1');
    if (!s.startsWith('{') && !s.startsWith('[') && s.startsWith("'") && s.endsWith("'")) {
      s = '"' + s.slice(1, -1).replace(/"/g, '\\"') + '"';
    }
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function coerceValue(typeDesc: any, rawVal: any) {
  if (rawVal === '' || rawVal === undefined) {
    if (typeof typeDesc === 'string') {
      if (typeDesc.includes('number')) return 0;
      if (typeDesc.includes('bool')) return false;
      if (typeDesc.includes('array')) return [];
      if (typeDesc.includes('object')) return {};
      return '';
    }
    return rawVal;
  }
  if (typeof typeDesc === 'string') {
    const t = typeDesc.toLowerCase();
    if (t.includes('number')) return Number(rawVal);
    if (t.includes('bool') || t === 'boolean') {
      if (typeof rawVal === 'boolean') return rawVal;
      return String(rawVal).toLowerCase() === 'true';
    }
    if (t.includes('array')) {
      if (Array.isArray(rawVal)) return rawVal;
      try { return JSON.parse(rawVal); } catch { return Array.isArray(rawVal) ? rawVal : [rawVal]; }
    }
    if (t.includes('object')) {
      if (typeof rawVal === 'object') return rawVal;
      try { return JSON.parse(rawVal); } catch { return rawVal; }
    }
    return String(rawVal);
  }
  if (typeof typeDesc === 'object') {
    if (typeof rawVal === 'object') return rawVal;
    try { return JSON.parse(rawVal); } catch { return rawVal; }
  }
  return rawVal;
}

const StatusBadge = ({ status }: { status?: string }) => {
  const cfg = {
    DEPLOYED: 'bg-green-500/20 text-green-400 border-green-400/30',
    TESTING: 'bg-yellow-500/20 text-yellow-400 border-yellow-400/30',
    PENDING: 'bg-blue-500/20 text-blue-400 border-blue-400/30',
    FAILED: 'bg-red-500/20 text-red-400 border-red-400/30',
    RUNNING: 'bg-cyan-500/20 text-cyan-400 border-cyan-400/30',
  } as Record<string, string>;
  return <span className={`px-3 py-1 rounded-full text-sm font-semibold border ${cfg[status ?? ''] ?? 'bg-gray-500/20 text-gray-400 border-gray-400/30'}`}>{status ?? 'UNKNOWN'}</span>;
};

export default function ToolTestPage() {
  const params = useParams();
  const router = useRouter();
  const toolId = params?.id as string;

  const [tool, setTool] = useState<Tool | null>(null);
  const [loading, setLoading] = useState(true);
  const [walletLoading, setWalletLoading] = useState(true);
  const [userWallet, setUserWallet] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'configuration' | 'test-data' | 'tests' | 'results'>('configuration');

  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [inputShape, setInputShape] = useState<any>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [rawJson, setRawJson] = useState('{}');

  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [sendingTest, setSendingTest] = useState(false);
  const [testing, setTesting] = useState(false);

  const [showEnv, setShowEnv] = useState<Record<string, boolean>>({});

  const [tests, setTests] = useState<Array<{ name?: string; input: Record<string, any> | string; expected: string }>>([
    { name: 'test-1', input: {}, expected: '' },
  ]);

  useEffect(() => {
    const localWallet = typeof window !== 'undefined' ? localStorage.getItem('walletAccountId') : null;
    if (localWallet) setUserWallet(localWallet);
    setWalletLoading(false);
  }, []);

  useEffect(() => {
    if (!toolId || walletLoading) return;
    loadTool();
  }, [toolId, walletLoading]);

  async function loadTool() {
    setLoading(true);
    try {
      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/tools/${toolId}`, {
        headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt || 'Failed to load tool');
      const data: Tool = JSON.parse(txt);
      setTool(data);
      const initialEnv: Record<string, string> = {};
      (data.requiredEnv ?? []).forEach((k) => (initialEnv[k] = ''));
      setEnvVars(initialEnv);
      let parsed = null;
      if (typeof data.inputShape === 'string') {
        parsed = tryParseToolInputShape(data.inputShape);
        if (parsed === null && data.inputShape === 'Not specified') parsed = 'string';
      } else parsed = data.inputShape ?? null;
      setInputShape(parsed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const init: Record<string, any> = {};
        Object.keys(parsed).forEach((k) => {
          const v = parsed[k];
          if (typeof v === 'string') {
            if (v.includes('number')) init[k] = 0;
            else if (v.includes('bool')) init[k] = false;
            else if (v.includes('array')) init[k] = '[]';
            else if (v.includes('object')) init[k] = '{}';
            else init[k] = '';
          } else init[k] = '';
        });
        setFormValues(init);
        setTests((prev) => prev.map(t => ({ ...t, input: { ...init, ...(typeof t.input === 'object' ? t.input : {}) } })));
      } else if (parsed && typeof parsed === 'string') {
        setFormValues({ input: '' });
        setTests((prev) => prev.map(t => ({ ...t, input: (typeof t.input === 'string' ? t.input : '') })));
      } else {
        setFormValues({});
        setRawJson('{}');
      }
    } catch (err) {
      console.error('loadTool error', err);
      alert(err instanceof Error ? err.message : 'Failed to load tool');
    } finally {
      setLoading(false);
    }
  }

  function handleEnvChange(k: string, v: string) {
    setEnvVars((p) => ({ ...p, [k]: v }));
  }

  function handleFormChange(k: string, v: any) {
    setFormValues((p) => ({ ...p, [k]: v }));
  }

  function buildPayloadFromForm() {
    if (!inputShape) {
      try { return JSON.parse(rawJson); } catch { throw new Error('Invalid raw JSON'); }
    }
    if (typeof inputShape === 'string') return formValues.input;
    if (typeof inputShape === 'object' && !Array.isArray(inputShape)) {
      const out: Record<string, any> = {};
      for (const k of Object.keys(inputShape)) out[k] = coerceValue(inputShape[k], formValues[k]);
      return out;
    }
    return formValues;
  }

  async function pollInstanceStatus(instanceId: string, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const token = getAuthToken();
        const res = await fetch(`${API_BASE}/instances/${instanceId}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' },
        });
        if (res.ok) {
          const inst = await res.json();
          if (inst.usageUrl && inst.status === 'RUNNING') return inst;
        }
      } catch (err) {
        console.error('poll error', err);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Instance failed to start within timeout');
  }

  async function startTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const token = getAuthToken();
      if (!token) {
        alert('Please log in to test tools');
        setTesting(false);
        return;
      }
      const res = await fetch(`${API_BASE}/tools/${toolId}/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: envVars }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt || 'Failed to start test');
      const result: TestResult = JSON.parse(txt);
      setTestResult(result);
      if (!result.instance?.usageUrl && result.instance?.id) {
        try {
          const updated = await pollInstanceStatus(result.instance.id);
          setTestResult((p) => (p ? { ...p, instance: updated } : { ...result, instance: updated }));
          if (updated.usageUrl) setActiveTab('test-data');
        } catch (err) {
          console.error('polling failed', err);
        }
      } else if (result.instance?.usageUrl) {
        setActiveTab('test-data');
      }
    } catch (err) {
      console.error('startTest error', err);
      alert(err instanceof Error ? err.message : 'Failed to start test');
    } finally {
      setTesting(false);
    }
  }

  async function sendTestData() {
    if (!testResult?.instance?.id) {
      alert('No test instance ready');
      return;
    }
    setSendingTest(true);
    try {
      const payload = buildPayloadFromForm();
      const res = await fetch(`${API_BASE}/instances/${testResult.instance.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt || `Status ${res.status}`);
      const out = JSON.parse(txt);
      setTestResult((p) => (p ? { ...p, testReport: out, success: true } : { instance: testResult?.instance ?? null, testReport: out, success: true }));
      setActiveTab('results');
    } catch (err) {
      console.error('sendTestData error', err);
      alert(err instanceof Error ? err.message : 'Failed to send test data');
    } finally {
      setSendingTest(false);
    }
  }

  useEffect(() => {
    if (!inputShape || typeof inputShape !== 'object' || Array.isArray(inputShape)) return;
    setTests((prev) =>
      prev.map((t) => {
        const nextInput = typeof t.input === 'object' ? { ...t.input } : {};
        Object.keys(inputShape).forEach((k) => { if (!(k in nextInput)) nextInput[k] = ''; });
        return { ...t, input: nextInput };
      })
    );
  }, [inputShape]);

  function addTest() {
    if (inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape)) {
      const empty: Record<string, any> = {};
      Object.keys(inputShape).forEach((k) => { empty[k] = ''; });
      setTests((p) => [...p, { name: `test-${p.length + 1}`, input: empty, expected: '' }]);
    } else {
      setTests((p) => [...p, { name: `test-${p.length + 1}`, input: typeof inputShape === 'string' ? '' : { raw: '{}' }, expected: '' }]);
    }
  }

  function removeTest(idx: number) {
    setTests((p) => p.filter((_, i) => i !== idx));
  }

  function updateTestField(idx: number, key: string, value: any) {
    setTests((p) => {
      const c = [...p];
      const t = c[idx];
      if (typeof t.input === 'object' && !Array.isArray(t.input)) t.input = { ...t.input, [key]: value };
      else if (key === 'input') t.input = value;
      else t.input = value;
      c[idx] = t;
      return c;
    });
  }

  async function deployWithTests() {
    if (!tool || !userWallet) return;
    setTesting(true);
    try {
      const token = getAuthToken();
      const built = tests.map((t) => {
        let inputPayload: any;
        if (inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape)) {
          inputPayload = {};
          for (const k of Object.keys(inputShape)) inputPayload[k] = coerceValue(inputShape[k], (t.input as Record<string, any>)[k]);
        } else if (inputShape && typeof inputShape === 'string') {
          inputPayload = t.input as string;
        } else {
          try { inputPayload = JSON.parse(typeof t.input === 'string' ? t.input : (t.input as any).raw ?? '{}'); } catch { inputPayload = {}; }
        }
        return { input: inputPayload, exptected: t.expected };
      });
      const payload = { env: envVars, tests: built };
      const res = await fetch(`${API_BASE}/tools/${toolId}/deploy`, {
        method: 'POST',
        headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(txt || `Deploy failed ${res.status}`);
      setTestResult({ success: true, testReport: txt });
      alert('✅ Deployment successful');
      router.push('/tools');
    } catch (err) {
      console.error('deploy error', err);
      alert(err instanceof Error ? err.message : 'Deploy failed');
    } finally {
      setTesting(false);
    }
  }

  if (walletLoading || loading) {
    return <div className="min-h-screen bg-[#0a0b14] flex items-center justify-center text-white text-xl">Loading…</div>;
  }

  if (!tool) {
    return <div className="min-h-screen bg-[#0a0b14] flex items-center justify-center text-white text-xl">Tool not found</div>;
  }

  return (
    <div className="min-h-screen bg-[#0a0b14] relative overflow-hidden">
      <div className="relative z-20 px-8 py-8 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <Link href={`/tools/${toolId}`} className="inline-flex items-center gap-2 text-cyan-400 hover:text-cyan-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Back to Tool
          </Link>
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-400">Wallet: <span className="text-cyan-400 font-mono">{userWallet ? `${userWallet.slice(0,8)}...${userWallet.slice(-6)}` : '—'}</span></div>
            <StatusBadge status={tool.status} />
          </div>
        </div>

        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Test <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">{tool.name}</span></h1>
          <p className="text-lg text-cyan-400 max-w-2xl mx-auto">Configure env, run a single test or define multiple tests and deploy.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6 mb-6">
              <div className="flex space-x-1 mb-6">
                {['configuration','test-data','tests','results'].map((t) => (
                  <button key={t} onClick={() => setActiveTab(t as any)} className={`px-5 py-2 rounded-xl font-medium transition-all capitalize ${activeTab === t ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-400/30' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{t.replace('-',' ')}</button>
                ))}
              </div>

              {activeTab === 'configuration' && (
                <div className="space-y-6">
                  <h3 className="text-white font-bold text-xl">Environment Variables</h3>
                  <p className="text-gray-400">Configure required environment variables for the tool.</p>
                  <div className="mt-4 space-y-4">
                    {tool.requiredEnv && tool.requiredEnv.length > 0 ? (
  tool.requiredEnv.map((k) => (
    <div key={k} className="mb-4">
      <label className="block text-white font-semibold mb-2">{k}</label>
      <div className="relative">
        <input
          type={showEnv[k] ? 'text' : 'password'}
          value={envVars[k] ?? ''}
          onChange={(e) => handleEnvChange(k, e.target.value)}
          className="w-full rounded-xl bg-white/10 border border-white/20 px-4 py-3 text-white pr-10"
          placeholder={`Enter ${k}`}
        />
        <button
          type="button"
          onClick={() => setShowEnv((p) => ({ ...p, [k]: !p[k] }))}
          className="absolute inset-y-0 right-3 flex items-center justify-center text-gray-400 hover:text-white"
        >
          {showEnv[k] ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-5 0-9.27-3-11-7 1.024-2.2 2.565-4.1 4.475-5.425m2.5-1.125a9.978 9.978 0 017 0m-7 0a9.978 9.978 0 00-2.5 1.125M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-5 0-9.27-3-11-7a11.936 11.936 0 015.4-5.426M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  ))
) : (
  <div className="text-gray-400">No environment variables required.</div>
)}

                  </div>

                  <div className="flex gap-4 pt-6 border-t border-white/10">
                    <button onClick={startTest} disabled={testing} className="flex-1 px-6 py-3 bg-gradient-to-r from-cyan-500 to-blue-500 text-white rounded-xl font-semibold">
                      {testing ? 'Starting Test...' : 'Start Test Deployment'}
                    </button>
                    <button onClick={() => { setEnvVars({}); }} className="px-6 py-3 bg-white/10 text-white rounded-xl">Clear</button>
                  </div>
                </div>
              )}

              {activeTab === 'test-data' && (
                <div className="space-y-6">
                  <h3 className="text-white font-bold text-xl">Single Test Input</h3>
                  <p className="text-gray-400">Provide test input according to tool input specification.</p>

                  <div className="mt-4 space-y-4">
                    {inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape) ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Object.keys(inputShape).map((k) => (
                          <div key={k} className="bg-white/5 rounded-xl p-4">
                            <label className="block text-white font-semibold mb-2">{k}</label>
                            <input value={formValues[k] ?? ''} onChange={(e) => handleFormChange(k, e.target.value)} className="w-full rounded-xl bg-white/10 border border-white/20 px-4 py-3 text-white" placeholder={typeof inputShape[k] === 'string' ? String(inputShape[k]) : ''} />
                          </div>
                        ))}
                      </div>
                    ) : inputShape && typeof inputShape === 'string' ? (
                      <div className="bg-white/5 rounded-xl p-4">
                        <label className="block text-white font-semibold mb-2">Input</label>
                        <textarea value={formValues.input ?? ''} onChange={(e) => handleFormChange('input', e.target.value)} rows={6} className="w-full rounded-xl bg-white/10 border border-white/20 px-4 py-3 text-white font-mono" />
                      </div>
                    ) : (
                      <div className="bg-white/5 rounded-xl p-4">
                        <label className="block text-white font-semibold mb-2">Raw JSON payload</label>
                        <textarea value={rawJson} onChange={(e) => setRawJson(e.target.value)} rows={6} className="w-full rounded-xl bg-white/10 border border-white/20 px-4 py-3 text-white font-mono" />
                      </div>
                    )}
                  </div>

                  <div className="flex gap-4 pt-6 border-t border-white/10">
                    <button onClick={sendTestData} disabled={sendingTest || !testResult?.instance?.id} className="flex-1 px-6 py-3 bg-gradient-to-r from-green-500 to-cyan-500 text-white rounded-xl font-semibold">
                      {sendingTest ? 'Sending...' : 'Send Test Data'}
                    </button>
                    <button onClick={() => { setFormValues({}); setRawJson('{}'); }} className="px-6 py-3 bg-white/10 text-white rounded-xl">Reset</button>
                  </div>
                </div>
              )}

              {activeTab === 'tests' && (
                <div className="space-y-6">
                  <h3 className="text-white font-bold text-xl">Tests & Deploy</h3>
                  <p className="text-gray-400">Create multiple tests (fields generated from inputShape) and run deployment tests.</p>

                  <div className="mt-4 space-y-4">
                    <div className="mb-4">
                      <h4 className="text-white font-semibold mb-2">Primary Input (preview)</h4>
                      <div className="bg-white/5 p-4 rounded-xl">
                        {inputShape ? (typeof inputShape === 'object' ? <pre className="text-xs text-white">{JSON.stringify(inputShape, null, 2)}</pre> : <div className="text-white">{String(inputShape)}</div>) : <div className="text-gray-400">No input shape provided</div>}
                      </div>
                    </div>

                    <div>
                      <h4 className="text-white font-semibold mb-3">Tests</h4>
                      <div className="space-y-3">
                        {tests.map((t, idx) => (
                          <div key={idx} className="bg-white/5 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-3">
                              <input value={t.name ?? `test-${idx+1}`} onChange={(e) => setTests((p) => { const c=[...p]; c[idx].name = e.target.value; return c; })} className="bg-transparent border border-white/10 px-3 py-1 rounded text-white" />
                              <button onClick={() => removeTest(idx)} className="text-red-400">Remove</button>
                            </div>

                            {inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape) ? (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                {Object.keys(inputShape).map((k) => (
                                  <div key={k}>
                                    <label className="block text-sm text-white mb-1">{k}</label>
                                    <input value={(t.input as Record<string, any>)[k] ?? ''} onChange={(e) => updateTestField(idx, k, e.target.value)} className="w-full rounded bg-white/10 border border-white/10 px-3 py-2 text-white" />
                                  </div>
                                ))}
                              </div>
                            ) : inputShape && typeof inputShape === 'string' ? (
                              <textarea value={typeof t.input === 'string' ? t.input : t.input?.input ?? ''} onChange={(e) => updateTestField(idx, 'input', e.target.value)} rows={4} className="w-full rounded bg-white/10 border border-white/10 px-3 py-2 text-white font-mono" />
                            ) : (
                              <textarea value={typeof t.input === 'string' ? t.input : t.input?.raw ?? ''} onChange={(e) => updateTestField(idx, 'raw', e.target.value)} rows={4} className="w-full rounded bg-white/10 border border-white/10 px-3 py-2 text-white font-mono" />
                            )}

                            <div className="mt-3">
                              <label className="block text-sm text-white mb-1">Expected (string)</label>
                              <textarea value={t.expected} onChange={(e) => setTests((p) => { const c=[...p]; c[idx].expected = e.target.value; return c; })} rows={2} className="w-full rounded bg-white/10 border border-white/10 px-3 py-2 text-white font-mono" />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div className="flex gap-3 mt-3">
                        <button onClick={addTest} className="px-4 py-2 bg-cyan-500 text-white rounded">Add Test</button>
                        <button onClick={() => setTests([{ name: 'test-1', input: inputShape && typeof inputShape === 'object' ? Object.keys(inputShape).reduce((a,c)=>({ ...a, [c]: ''}), {}) : (typeof inputShape === 'string' ? '' : { raw: '{}' }) , expected: '' }])} className="px-4 py-2 border rounded">Reset Tests</button>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-4 pt-6 border-t border-white/10">
                    <button onClick={deployWithTests} disabled={testing} className="flex-1 px-6 py-3 bg-gradient-to-r from-purple-500 to-pink-500 text-white rounded-xl font-semibold">
                      {testing ? 'Deploying...' : 'Deploy with Tests'}
                    </button>
                    <button onClick={() => { setEnvVars({}); setTests([{ name: 'test-1', input: {}, expected: '' }]); }} className="px-6 py-3 bg-white/10 text-white rounded-xl">Reset</button>
                  </div>
                </div>
              )}

              {activeTab === 'results' && (
                <div className="space-y-6">
                  <h3 className="text-white font-bold text-xl">Results</h3>
                  {testResult ? (
                    <div className="space-y-4">
                      <div className={`p-4 rounded-xl border ${testResult.success ? 'bg-green-500/20 border-green-400/30 text-green-400' : 'bg-red-500/20 border-red-400/30 text-red-400'}`}>
                        <div className="flex items-center gap-3">
                          <div className={`w-3 h-3 rounded-full ${testResult.success ? 'bg-green-400' : 'bg-red-400'}`}></div>
                          <span className="font-semibold">{testResult.success ? 'Success' : 'Failure'}</span>
                        </div>
                        {testResult.reason && <p className="mt-2 text-sm">{testResult.reason}</p>}
                      </div>

                      {testResult.instance && (
                        <div className="bg-white/5 rounded-xl p-4">
                          <h4 className="text-white font-semibold mb-3">Test Instance</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between"><span className="text-gray-400">Instance ID:</span><span className="text-white font-mono">{testResult.instance.id}</span></div>
                            <div className="flex justify-between"><span className="text-gray-400">Status:</span><StatusBadge status={testResult.instance.status} /></div>
                            {testResult.instance.usageUrl && <div className="flex justify-between"><span className="text-gray-400">URL:</span><span className="text-cyan-400 font-mono text-xs">{testResult.instance.usageUrl}</span></div>}
                          </div>
                        </div>
                      )}

                      {testResult.testReport && (
                        <div className="bg-white/5 rounded-xl p-4">
                          <h4 className="text-white font-semibold mb-3">Report</h4>
                          <pre className="text-sm text-gray-300 bg-black/20 p-4 rounded-lg overflow-auto">{typeof testResult.testReport === 'string' ? testResult.testReport : JSON.stringify(testResult.testReport, null, 2)}</pre>
                        </div>
                      )}

                      {testResult.details && (
                        <div className="bg-white/5 rounded-xl p-4">
                          <h4 className="text-white font-semibold mb-3">Details</h4>
                          <pre className="text-sm text-gray-300 bg-black/20 p-4 rounded-lg overflow-auto">{JSON.stringify(testResult.details, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-8"><p className="text-gray-400">No results yet. Run tests or deploy to see results.</p></div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-1">
            <div className="sticky top-8 space-y-6">
              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6">
                <h3 className="text-white font-bold text-lg mb-4">Tool Info</h3>
                <div className="space-y-3 text-sm">
                  <div><span className="text-gray-400">Name</span><div className="text-white font-semibold">{tool.name}</div></div>
                  <div><span className="text-gray-400">Input Shape</span><pre className="text-white text-xs mt-1 bg-black/20 p-2 rounded-lg overflow-auto max-h-32">{typeof tool.inputShape === 'string' ? tool.inputShape : JSON.stringify(tool.inputShape, null, 2)}</pre></div>
                  <div><span className="text-gray-400">Output Shape</span><pre className="text-white text-xs mt-1 bg-black/20 p-2 rounded-lg overflow-auto max-h-32">{typeof tool.outputShape === 'string' ? tool.outputShape : JSON.stringify(tool.outputShape, null, 2)}</pre></div>
                </div>
              </div>

              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6">
                <h3 className="text-white font-bold text-lg mb-4">Quick Actions</h3>
                <div className="space-y-3">
                  <button onClick={() => setActiveTab('configuration')} className="w-full py-2 bg-cyan-500 text-black rounded">Configure Env</button>
                  <button onClick={() => setActiveTab('test-data')} className="w-full py-2 bg-green-500 text-black rounded">Single Test</button>
                  <button onClick={() => setActiveTab('tests')} className="w-full py-2 bg-purple-500 text-black rounded">Tests & Deploy</button>
                  <button onClick={() => router.push('/tools')} className="w-full py-2 border rounded text-white">Back to Tools</button>
                </div>
              </div>

              <div className="bg-white/5 backdrop-blur-sm border border-white/10 rounded-2xl p-6">
                <h3 className="text-white font-bold text-lg mb-4">Need Help?</h3>
                <p className="text-gray-400 text-sm mb-4">If runner calls fail, ensure the runner exposes CORS and that instances are running.</p>
                <button className="w-full py-3 rounded-xl bg-white/10 text-white font-semibold">Get Support</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
