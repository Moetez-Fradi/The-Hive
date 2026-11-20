'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import axios from 'axios';

/* Types (lightweight) */
type PrivateWorkflowInstance = {
  id: string;
  graphJson: any;
  ownerUserId: string;
  usageUrl?: string | null;
  createdAt: string;
  workflowId?: string | null;
};

interface Tool {
  id: string;
  name: string;
  description?: string;
  inputShape?: string;
  outputShape?: string;
  requiredEnv: string[];
}

type Workflow = {
  id: string;
  graphJson: any;
  name?: string;
  description?: string;
};

function tryParseToolInputShape(raw: string | undefined | null): any | null {
  if (!raw) return null;

  // 1) try native JSON.parse first
  try {
    return JSON.parse(raw);
  } catch {}

  // 2) try to normalize common non-JSON shapes:
  try {
    let s = raw.trim();

    // replace backticks with double quotes
    s = s.replace(/`/g, '"');

    // add quotes to unquoted object keys: { key:  -> { "key":
    // also works after commas: , key:
    s = s.replace(/([{,]\s*)([A-Za-z0-9_\-$]+)\s*:/g, '$1"$2":');

    // convert single-quoted string values: : 'value' -> : "value"
    s = s.replace(/:\s*'([^']*)'/g, ': "$1"');

    // convert key: "value" (already ok) and remove trailing commas before } or ]
    s = s.replace(/,(\s*[}\]])/g, '$1');

    // If it's using single quotes for the whole thing, convert them to double quotes
    // but only if we don't look like valid JSON already.
    // (This is less aggressive because it could break legitimate strings containing apostrophes.)
    if (!s.startsWith('{') && !s.startsWith('[') && s.startsWith("'") && s.endsWith("'")) {
      s = '"' + s.slice(1, -1).replace(/"/g, '\\"') + '"';
    }

    return JSON.parse(s);
  } catch (e) {
    console.warn('Could not parse tool inputShape:', raw);
    return null;
  }
}


export default function WorkflowTesterPage() {
  const params = useParams();
  const instanceId = params?.id;
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [instance, setInstance] = useState<PrivateWorkflowInstance | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  // derived input state
  const [inputShape, setInputShape] = useState<any>(null); // object or string or null
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [rawJson, setRawJson] = useState(''); // fallback JSON textarea
  const [submitting, setSubmitting] = useState(false);
  const [responseText, setResponseText] = useState<string | null>(null);
  const [responseData, setResponseData] = useState<any>(null); // parsed response for outputs

  useEffect(() => {
    if (!instanceId) return;

    const fetchInstanceAndWorkflow = async () => {
      setLoading(true);
      setError(null);

      // parse token
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
        // 1) fetch instance
        const instRes = await axios.get<PrivateWorkflowInstance>(
          `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflow-instances/${instanceId}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const inst = instRes.data;
        setInstance(inst);

        // 2) fetch workflow if workflowId exists
        let wf: Workflow | null = null;
        if (inst.workflowId) {
          try {
            const wfRes = await axios.get<Workflow>(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflows/${inst.workflowId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            wf = wfRes.data;
            setWorkflow(wf);
          } catch (wfErr) {
            console.warn('Failed to fetch workflow', wfErr);
          }
        }

        // 3) Get first node in the hierarchy and fetch its tool to obtain the authoritative inputShape
        const sourceGraph = wf?.graphJson ?? inst.graphJson;
        const firstNode = sourceGraph?.nodes?.[0];

        let toolInputShape: any = null;
        if (firstNode?.toolId) {
          try {
            const toolRes = await axios.get<Tool>(
              `${process.env.NEXT_PUBLIC_BACKEND_URL}/tools/${firstNode.toolId}`,
              { headers: { Authorization: `Bearer ${token}` } }
            );
            toolInputShape = toolRes.data.inputShape ?? null;

            // parse JSON string shapes
           if (typeof toolInputShape === 'string') {
  const parsed = tryParseToolInputShape(toolInputShape);
  if (parsed !== null) toolInputShape = parsed;
}
          } catch (toolErr) {
            console.warn('Failed to fetch tool input shape', toolErr);
          }
        } else {
          // fallback: try to read inputShape directly from the first node in graph (if present)
          let shape =
            firstNode?.inputShape ??
            firstNode?.data?.inputShape ??
            firstNode?.input_shape ??
            null;
          if (typeof shape === 'string') {
            try {
              shape = JSON.parse(shape);
            } catch {}
          }
          toolInputShape = shape;
        }

        setInputShape(toolInputShape);

        // initialize form values based on shape
        if (toolInputShape && typeof toolInputShape === 'object' && !Array.isArray(toolInputShape)) {
          const initial: Record<string, any> = {};
          Object.keys(toolInputShape).forEach((k) => {
            initial[k] = '';
          });
          setFormValues(initial);
        } else if (toolInputShape && typeof toolInputShape === 'string') {
          // textual shape -> single 'input' field (will send raw string)
          setFormValues({ input: '' });
        } else {
          setRawJson('{}');
        }
      } catch (err: any) {
        console.error(err);
        setError(err.response?.data?.message || err.message || 'Failed to load instance');
      } finally {
        setLoading(false);
      }
    };

    fetchInstanceAndWorkflow();
  }, [instanceId]);

  const handleChange = (key: string, val: string) => {
    setFormValues((prev) => ({ ...prev, [key]: val }));
  };

  const handleSubmit = async (e: any) => {
    e?.preventDefault();
    if (!instance) return;
    if (!instance.usageUrl) {
      alert('This instance is not yet deployed (no usageUrl).');
      return;
    }

    // build payload — **send exactly the tool's input shape**, not wrapped
    let payload: any;
    if (inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape)) {
      // send the object whose keys are the inputShape keys
      payload = { ...formValues };
    } else if (inputShape && typeof inputShape === 'string') {
      // send the raw string value if the tool expects a simple string
      payload = formValues.input;
    } else {
      // fallback: send parsed raw JSON
      try {
        payload = JSON.parse(rawJson);
      } catch (err) {
        alert('Invalid JSON in raw input');
        return;
      }
    }

    setSubmitting(true);
    setResponseText(null);
    setResponseData(null);

    const finalPayload = {
        "input": payload
    };
    let token = '';
    try {
      token = JSON.parse(localStorage.getItem('access_token') ?? '{}').state?.token ?? '';
    } catch {}
    try {
      const resp = await axios.post(
        `${process.env.NEXT_PUBLIC_BACKEND_URL}/workflow-instances/${instance.id}/run`,
        finalPayload,
        { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
      );

      setResponseData(resp.data);
      setResponseText(JSON.stringify(resp.data, null, 2));
    } catch (err: any) {
      console.error(err);
      const message = err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message;
      setResponseText(`Request failed: ${err.response?.status || ''}\n${message}`);
      setResponseData(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (!instanceId) return <div className="p-8">No instance id provided</div>;
  if (loading) return <div className="p-8">Loading…</div>;
  if (error) return <div className="p-8 text-red-400">Error: {error}</div>;
  if (!instance) return <div className="p-8">Instance not found</div>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Test workflow instance</h1>
      <p className="mb-4 text-sm text-gray-300">Instance ID: {instance.id}</p>
      <p className="mb-6 text-sm text-gray-400">Workflow: {workflow?.id ?? instance.workflowId ?? '—'}</p>

      {instance.usageUrl ? (
        <div className="mb-4 p-4 bg-green-900/20 border border-green-800 text-green-200 rounded">
          Test containers are running for the next 25 minutes. Try a few inputs, then deploy.
        </div>
        
      ) : (
        <div className="mb-4 p-4 bg-yellow-900/20 border border-yellow-800 text-yellow-200 rounded">
          This instance does not expose a usage URL yet — the runner may still be provisioning. Try again later.
        </div>
      )}

      <button
  type="button"
  onClick={() => router.push(`/workflows/deploy/${instance.id}`)}
  className="px-4 py-2 bg-green-500 text-black rounded hover:bg-green-600 transition"
>
  Deploy
</button>

      <form onSubmit={handleSubmit} className="space-y-4 max-w-2xl">
        {/* Structured inputs from tool inputShape */}
        {inputShape && typeof inputShape === 'object' && !Array.isArray(inputShape) && (
          <div>
            <h3 className="font-semibold mb-2">Inputs</h3>
            <div className="space-y-3">
              {Object.keys(inputShape).map((key) => (
                <div key={key} className="flex flex-col">
                  <label className="block text-sm text-gray-300 mb-1">{key}</label>

                  {/* special case: 'text' -> textarea */}
                  {key === 'text' ? (
                    <textarea
                      value={formValues[key] ?? ''}
                      onChange={(e) => handleChange(key, e.target.value)}
                      className="w-full h-28 bg-[#071424] border border-white/6 rounded p-2 font-mono"
                      placeholder={typeof inputShape[key] === 'string' ? (inputShape[key] as string) : ''}
                    />
                  ) : (
                    <input
                      type="text"
                      value={formValues[key] ?? ''}
                      onChange={(e) => handleChange(key, e.target.value)}
                      className="w-full bg-[#071424] border border-white/6 rounded p-2"
                      placeholder={typeof inputShape[key] === 'string' ? (inputShape[key] as string) : ''}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Single textual input shape (rare) */}
        {inputShape && typeof inputShape === 'string' && (
          <div>
            <label className="block text-sm text-gray-300 mb-1">Value</label>
            <textarea
              value={formValues.input ?? ''}
              onChange={(e) => handleChange('input', e.target.value)}
              className="w-full h-40 bg-[#071424] border border-white/6 rounded p-2 font-mono"
            />
          </div>
        )}

        {/* Raw JSON fallback */}
        {!inputShape && (
          <div>
            <label className="block text-sm text-gray-300 mb-1">Raw JSON payload</label>
            <textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              className="w-full h-56 bg-[#071424] border border-white/6 rounded p-2 font-mono"
            />
          </div>
        )}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={!instance.usageUrl || submitting}
            className="px-4 py-2 bg-cyan-400 text-black rounded"
          >
            {submitting ? 'Sending…' : 'Send to usage URL'}
          </button>

          <button
            type="button"
            onClick={() => router.push('/workflows')}
            className="px-4 py-2 border rounded border-white/10 text-white"
          >
            Back to workflows
          </button>
        </div>
      </form>

      {/* Parsed outputs: list top-level keys if response is an object */}
      {responseData && typeof responseData === 'object' && !Array.isArray(responseData) && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">Outputs</h3>
          <div className="grid grid-cols-1 gap-3 max-w-2xl">
            {Object.keys(responseData).map((k) => (
              <div key={k} className="p-3 bg-[#071424] border border-white/6 rounded">
                <div className="text-xs text-gray-400 mb-1">{k}</div>
                <pre className="font-mono text-sm whitespace-pre-wrap">{JSON.stringify(responseData[k], null, 2)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Raw runner response */}
      {responseText && (
        <div className="mt-6">
          <h3 className="font-semibold mb-2">Runner response</h3>
          <pre className="bg-[#071424] border border-white/6 rounded p-4 font-mono whitespace-pre-wrap">{responseText}</pre>
        </div>
      )}
    </div>
  );
}
