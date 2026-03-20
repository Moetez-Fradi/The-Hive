import express from "express";
import dotenv from "dotenv";
import { decryptEnv } from "./utils/decrypt.js";
import { pullImage, waitForUrl } from "./utils/docker.js";
import Docker from "dockerode";
import axios from "axios";
import cors from "cors";

const docker = new Docker();
dotenv.config();
const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',           // allow all origins
  methods: ['GET','POST','PUT','DELETE','PATCH','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','Accept'],
}));

app.post("/run", async (req, res) => {
  try {
    const { instanceId, dockerImageUrl, envCipher } = req.body;
    const envVars = decryptEnv(envCipher);

    await pullImage(dockerImageUrl);

    const hostPort = 30000 + Math.floor(Math.random() * 1000);

    const container = await docker.createContainer({
      Image: dockerImageUrl,
      Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { "80/tcp": {} },
      HostConfig: {
        PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] },
        AutoRemove: true,
      },
      name: `tool_${instanceId}`,
    });

    await container.start();
    console.log(`Instance ${instanceId} running at localhost:${hostPort}`);

    setTimeout(async () => {
      try {
        await container.stop();
        console.log(`Instance ${instanceId} stopped after 10 minutes`);
      } catch (e) {}
    }, 10 * 60 * 1000);

    res.json({
      usageUrl: `http://localhost:${hostPort}`,
      port: hostPort,
    });
  } catch (e) {
    console.error("Error starting container:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/run-and-test", async (req, res) => {
  try {
    console.log("we got in!");
    const { instanceId, dockerImageUrl, envCipher, tests = [] } = req.body;
    if (!instanceId || !dockerImageUrl || !envCipher)
      return res.status(400).json({ error: "instanceId, dockerImageUrl, envCipher required" });

    const envVars = decryptEnv(envCipher);
    console.log("we got the cipher: ", envCipher);
    await pullImage(dockerImageUrl);
    console.log("pulled!");

    const hostPort = 30000 + Math.floor(Math.random() * 10000);

    const container = await docker.createContainer({
      Image: dockerImageUrl,
      Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { "80/tcp": {} },
      HostConfig: { PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] }, AutoRemove: true },
      name: `tool_${instanceId}`,
    });

    console.log("container created.")

    await container.start();
    console.log("container started.");
    const baseUrl = `http://localhost:${hostPort}`;

    console.log("ready!");

    const results = [];
    let totalMs = 0;
    let totalOutBytes = 0;
    let totalMemMB = 0;

    let inputShape = req.inputShape;
    let outputShape = req.outputShape;

  for (const t of tests) {
    const shape = typeof inputShape === "string" ? JSON.parse(inputShape) : inputShape;
    const expectedShape = typeof outputShape === "string" ? JSON.parse(outputShape) : outputShape;

    console.log(t.input);

    const input = t.input;

    const expected = t.expected;
    let out, duration, memUsage;

    console.log(input);

    const start = Date.now();
    try {
      const preStats = await container.stats({ stream: false });
      const r = await axios.post(`${baseUrl}/run`, input, { timeout: 20000 });
      const postStats = await container.stats({ stream: false });

      duration = Date.now() - start;
      out = r.data;

      const memNow = postStats.memory_stats?.usage || preStats.memory_stats?.usage || 0;
      memUsage = memNow / 1024 / 1024;
    } catch (e) {
      results.push({ input, error: e.message, ok: false });
      continue;
    }

    const outStr = JSON.stringify(out);
    const outBytes = Buffer.byteLength(outStr, "utf8");
    totalMs += duration;
    totalOutBytes += outBytes;
    totalMemMB += memUsage;

    let ok = true;
    if (expected) {
      for (const [key, expectedVal] of Object.entries(expected)) {
        if (out[key] === undefined) {
          ok = false;
          break;
        }
        if (typeof expectedVal === 'string' && typeof out[key] !== typeof expectedVal) {
          ok = false;
          break;
        }
        if (expectedVal !== null && expectedVal !== undefined && out[key] != expectedVal) {
          ok = false;
          break;
        }
      }
    } else if (expectedShape) {
      for (const key of Object.keys(expectedShape)) {
        if (!(key in out)) {
          ok = false;
          break;
        }
      }
    }

    results.push({ input, output: out, ok, timeMs: duration, memMB: memUsage });
  }

    const testCount = Math.max(1, results.length);
    const avgMs = totalMs / testCount;
    const avgMemMB = totalMemMB / testCount;
    const avgOutBytes = totalOutBytes / testCount;

    const timeVals = results.map(r => r.timeMs || avgMs);
    const mean = avgMs;
    const variance =
      timeVals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / timeVals.length;
    const stability = 1 - Math.min(variance / mean ** 2, 1);
    const priceMode = stability > 0.8 ? "FIXED" : "DYNAMIC";

    const cpuPowerW = 25;
    const memPowerW = 0.3 * avgMemMB;
    const energyJ = (avgMs / 1000) * (cpuPowerW + memPowerW);
    const energyBaseline = Math.round(energyJ * 1000) / 1000;

    const USD_PER_JOULE = 0.000000005;
    const USD_PER_MB = 0.00001;

    const baseCost = energyJ * USD_PER_JOULE + avgMemMB * USD_PER_MB;
    const fixedPrice = Number((baseCost * 1.5).toFixed(6));
    const dynamicInputCoeff = Number((baseCost * 0.1).toFixed(6));
    const dynamicOutputCoeff = Number((avgOutBytes * 0.0000002).toFixed(6));

    const passedAll = results.every(r => r.ok);

    try {
      await container.stop();
    } catch {}

    return res.json({
      passed: passedAll,
      metrics: { avgMs, avgMemMB, avgOutBytes, stability, results },
      pricing: {
        priceMode,
        fixedPrice,
        dynamicInputCoeff,
        dynamicOutputCoeff,
      },
      energyBaseline,
    });
  } catch (e) {
    console.error("run-and-test error:", e);
    res.status(500).json({ error: e.message });
  }
});

const workflowStore = new Map();
function topoSortNodes(nodes = [], edges = []) {
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const ad = new Map(nodes.map(n => [n.id, []]));
  edges.forEach(e => {
    ad.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  });
  const q = [];
  for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);
  const order = [];
  while (q.length) {
    const n = q.shift();
    order.push(n);
    for (const nb of ad.get(n)) {
      indeg.set(nb, indeg.get(nb) - 1);
      if (indeg.get(nb) === 0) q.push(nb);
    }
  }
  return order;
}

app.post("/run-workflow", async (req, res) => {
  try {
    const { instanceId, graphJson, envCipher } = req.body;
    if (!instanceId || !graphJson)
      return res.status(400).json({ error: "instanceId and graphJson required" });

    const envVars = envCipher ? decryptEnv(envCipher) : {};
    const containers = {};

    for (const node of graphJson.nodes) {
      await pullImage(node.dockerImageUrl);
      const hostPort = 30000 + Math.floor(Math.random() * 10000);

      const envVarsNode = node.env || envVars;

      const container = await docker.createContainer({
        Image: node.dockerImageUrl,
        Env: Object.entries(envVarsNode).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { "80/tcp": {} },
        HostConfig: {
          PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] },
          AutoRemove: true,
        },
        name: `${instanceId}_${node.id}`,
      });

      await container.start();
      containers[node.id] = {
        container,
        usageUrl: `http://localhost:${hostPort}`,
      };
      console.log(`Node ${node.name} running at ${containers[node.id].usageUrl}`);
    }

    setTimeout(async () => {
      for (const c of Object.values(containers)) {
        try {
          await c.container.stop();
        } catch {}
      }
      workflowStore.delete(instanceId);
      console.log(`Workflow ${instanceId} stopped after 10min`);
    }, 25 * 60 * 1000);

    workflowStore.set(instanceId, { graphJson, containers });
    res.json({
      usageUrl: `${req.protocol}://${req.get("host")}/workflow/${instanceId}/run`,
    });
  } catch (e) {
    console.error("run-workflow error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/workflow/:instanceId/run", async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { input: globalInput = {} } = req.body;
    const wf = workflowStore.get(instanceId);
    if (!wf) return res.status(404).json({ error: "Workflow instance not found" });

    const { graphJson, containers } = wf;
    const nodes = graphJson.nodes;
    const edges = graphJson.edges || [];

    const order = topoSortNodes(nodes, edges);
    const results = {};

    const getByPath = (obj, path) => {
      if (!path) return undefined;
      const parts = path.split(".").map(p => p.trim());
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
      }
      return cur;
    };

    const interpolateTemplate = (tpl, context) => {
      return tpl.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
        const key = expr.trim();
        const val = getByPath(context, key);
        return val === undefined || val === null ? "" : String(val);
      });
    };

    const evalCondition = (cond, context) => {
      if (!cond) return true;
      try {
        const fn = new Function("ctx", `with (ctx) { return (${cond}); }`);
        return Boolean(fn(context));
      } catch (err) {
        return false;
      }
    };

    for (const nodeId of order) {
      const node = nodes.find(n => n.id === nodeId);
      const url = containers[nodeId].usageUrl;

      let nodeInput = {};
      const incoming = edges.filter(e => e.to === nodeId);

      if (incoming.length === 0) {
        nodeInput = { ...globalInput };
      } else {
        for (const e of incoming) {
          const fromResult = results[e.from];
          if (!fromResult) continue;

          const sourceOutput = fromResult.output ?? {};
          const sourceInput = fromResult.input ?? {};
          const mergedContext = { ...globalInput, ...sourceOutput, ...sourceInput };

          const conditionPassed = evalCondition(e.condition, mergedContext);
          if (!conditionPassed) continue;

          const mapped = {};
          for (const [k, v] of Object.entries(e.mapping || {})) {
            if (typeof v === "string") {
              mapped[k] = interpolateTemplate(v, mergedContext);
            } else {
              mapped[k] = v;
            }
          }

          if (!nodeInput._stack) nodeInput._stack = [];
          nodeInput._stack.push({ from: e.from, mapping: mapped, matched: true });
          Object.assign(nodeInput, mapped);
        }
      }

      if (Object.keys(nodeInput).length === 0 && incoming.length > 0) {
        results[nodeId] = {
          input: {},
          output: null,
          status: "skipped",
          reason: "no incoming edge matched or produced input"
        };
        continue;
      }

      try {
        const r = await axios.post(`${url}/run`, nodeInput, { timeout: 20000 });
        results[nodeId] = {
          input: nodeInput,
          output: r.data,
          status: "ok"
        };
      } catch (err) {
        const errInfo = {
          message: err.message,
          status: err.response?.status,
          response: err.response?.data
        };
        results[nodeId] = {
          input: nodeInput,
          output: null,
          status: "error",
          error: errInfo
        };
      }
    }

    res.json({ success: true, results });
  } catch (e) {
    console.error("workflow run error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/run-workflow-and-test", async (req, res) => {
  try {
    const { instanceId, graphJson, envCipher, tests = [], globalInput = {} } = req.body;
    if (!instanceId || !graphJson) 
      return res.status(400).json({ error: "instanceId and graphJson required" });

    const envVars = envCipher ? decryptEnv(envCipher) : {};
    const containers = {};

    for (const node of graphJson.nodes) {
      await pullImage(node.dockerImageUrl);
      const hostPort = 30000 + Math.floor(Math.random() * 10000);
      const envVarsNode = node.env || envVars;

      const container = await docker.createContainer({
        Image: node.dockerImageUrl,
        Env: Object.entries(envVarsNode).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { "80/tcp": {} },
        HostConfig: {
          PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] },
          AutoRemove: true,
        },
        name: `${instanceId}_${node.id}`,
      });

      await container.start();
      containers[node.id] = {
        container,
        usageUrl: `http://localhost:${hostPort}`,
      };
      console.log(`Node ${node.name} running at ${containers[node.id].usageUrl}`);
    }

    workflowStore.set(instanceId, { graphJson, containers });

    const getByPath = (obj, path) => path?.split(".").reduce((acc, key) => acc?.[key], obj);
    const interpolateTemplate = (tpl, ctx) =>
      tpl.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
        const val = getByPath(ctx, expr.trim());
        return val == null ? "" : String(val);
      });
    const evalCondition = (cond, ctx) => {
      if (!cond) return true;
      try { return Boolean(new Function("ctx", `with(ctx){return (${cond});}`)(ctx)); }
      catch { return false; }
    };

    const order = topoSortNodes(graphJson.nodes, graphJson.edges || []);
    const nodeResults = {};

    for (const test of tests) {
      const testResults = {};
      for (const nodeId of order) {
        const node = graphJson.nodes.find(n => n.id === nodeId);
        const url = containers[nodeId].usageUrl;

        let nodeInput = {};
        const incoming = (graphJson.edges || []).filter(e => e.to === nodeId);

        if (incoming.length === 0) nodeInput = { ...globalInput, ...test.input };
        else {
          for (const e of incoming) {
            const fromResult = nodeResults[e.from] || {};
            const merged = { ...globalInput, ...fromResult.output, ...fromResult.input };
            if (!evalCondition(e.condition, merged)) continue;

            const mapped = {};
            for (const [k, v] of Object.entries(e.mapping || {})) {
              mapped[k] = typeof v === "string" ? interpolateTemplate(v, merged) : v;
            }

            if (!nodeInput._stack) nodeInput._stack = [];
            nodeInput._stack.push({ from: e.from, mapping: mapped, matched: true });
            Object.assign(nodeInput, mapped);
          }
        }

        if (Object.keys(nodeInput).length === 0 && incoming.length > 0) {
          testResults[nodeId] = { input: {}, output: null, status: "skipped" };
          continue;
        }

        try {
          const r = await axios.post(`${url}/run`, nodeInput, { timeout: 20000 });
          testResults[nodeId] = { input: nodeInput, output: r.data, status: "ok" };
        } catch (err) {
          testResults[nodeId] = {
            input: nodeInput,
            output: null,
            status: "error",
            error: {
              message: err.message,
              status: err.response?.status,
              response: err.response?.data,
            },
          };
        }
      }
      nodeResults[test.name || `test_${tests.indexOf(test)}`] = testResults;
    }

    res.json({
      success: true,
      workflowUsageUrl: `${req.protocol}://${req.get("host")}/workflow/${instanceId}/run`,
      containers: Object.fromEntries(Object.entries(containers).map(([id, c]) => [id, c.usageUrl])),
      results: nodeResults,
    });
  } catch (e) {
    console.error("run-workflow-and-test error:", e);
    res.status(500).json({ error: e.message });
  }
});

const decentralizedStore = new Map();

app.post('/register-decentralized', async (req, res) => {
  try {
    const { instanceId, graphJson, mapping, tests = [] } = req.body;
    if (!instanceId || !graphJson || !mapping) return res.status(400).json({ error: 'instanceId, graphJson, mapping required' });

    // mapping: { nodeId: usageUrl }
    decentralizedStore.set(instanceId, { graphJson, mapping, tests });

    // Return the unified usageUrl for orchestrated runs
    const workflowUsageUrl = `${req.protocol}://${req.get('host')}/decentralized/workflow/${instanceId}/run`;
    res.json({ success: true, workflowUsageUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/decentralized/workflow/:instanceId/run', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const wf = decentralizedStore.get(instanceId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });

    const { graphJson, mapping } = wf;
    const { input: globalInput = {} } = req.body;

    // Normalize nodes list
    const nodes = graphJson.nodes || [];
    // Build edges: prefer explicit edges if present; otherwise derive from node.inputs
    let edges = graphJson.edges || [];
    if ((!edges || edges.length === 0) && nodes.some(n => n.inputs && n.inputs.length)) {
      edges = [];
      for (const node of nodes) {
        for (const inp of node.inputs || []) {
          if (!inp.source) continue;
          // Build a mapping template that references the source's output.
          // If input has a 'path' field, reference it; otherwise use whole output.
          const sourcePath = inp.path ? `${inp.source}.${inp.path}` : inp.source;
          edges.push({
            from: inp.source,
            to: node.id,
            // mapping will map the destination input name -> template that resolves to the relevant value
            mapping: { [inp.name]: `{{${sourcePath}}}` },
            condition: inp.condition || null
          });
        }
      }
    }

    // Helpers (kept similar to centralized implementation)
    const getByPath = (obj, path) => {
      if (!path) return undefined;
      const parts = path.split('.').map(p => p.trim());
      let cur = obj;
      for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
      }
      return cur;
    };

    const interpolateTemplate = (tpl, context) => {
      return tpl.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
        const key = expr.trim();
        const val = getByPath(context, key);
        return val === undefined || val === null ? "" : String(val);
      });
    };

    const evalCondition = (cond, context) => {
      if (!cond) return true;
      try {
        const fn = new Function("ctx", `with (ctx) { return (${cond}); }`);
        return Boolean(fn(context));
      } catch (err) {
        return false;
      }
    };

    // Topo sort using your earlier helper (nodes must be an array with .id)
    const nodeOrder = topoSortNodes(nodes, edges);

    const results = {}; // will hold { input, output, status, error? } keyed by nodeId

    for (const nodeId of nodeOrder) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) {
        results[nodeId] = { input: {}, output: null, status: 'error', error: 'node-not-found' };
        continue;
      }

      // incoming edges for this node
      const incoming = edges.filter(e => e.to === nodeId);

      // Build nodeInput
      let nodeInput = {};
      if (incoming.length === 0) {
        // no dependencies -> start with global input
        nodeInput = { ...globalInput };
      } else {
        // For each incoming edge, merge context from the source result, evaluate condition, apply mapping
        for (const e of incoming) {
          const fromResult = results[e.from];
          if (!fromResult) {
            // If a source didn't run (missing), skip this edge
            continue;
          }

          const sourceOutput = fromResult.output || {};
          const sourceInput = fromResult.input || {};
          // mergedContext allows mapping templates to reference fields directly
          const mergedContext = { ...globalInput, ...sourceOutput, ...sourceInput };

          const conditionPassed = evalCondition(e.condition, mergedContext);
          if (!conditionPassed) continue;

          const mapped = {};
          for (const [k, v] of Object.entries(e.mapping || {})) {
            if (typeof v === "string") {
              mapped[k] = interpolateTemplate(v, mergedContext);
            } else {
              // allow literal values
              mapped[k] = v;
            }
          }

          if (!nodeInput._stack) nodeInput._stack = [];
          nodeInput._stack.push({ from: e.from, mapping: mapped, matched: true });

          // merge mapped fields into nodeInput (same semantics as centralized)
          Object.assign(nodeInput, mapped);
        }
      }

      // If this node had incoming edges but produced no input (no edge matched), mark skipped
      if (Object.keys(nodeInput).length === 0 && incoming.length > 0) {
        results[nodeId] = {
          input: {},
          output: null,
          status: "skipped",
          reason: "no incoming edge matched or produced input"
        };
        continue;
      }

      // Resolve the remote URL for this node from the provided mapping
      const nodeUrl = mapping[nodeId];
      if (!nodeUrl) {
        results[nodeId] = {
          input: nodeInput,
          output: null,
          status: "error",
          error: `No mapped node URL for ${nodeId}`
        };
        continue;
      }

      // Call remote node
      try {
        const r = await axios.post(`${nodeUrl}/run`, nodeInput, { timeout: 20000 });

        // Accept both shapes: { output: ... } (some runners) or raw response body
        const normalizedOut = r.data && r.data.output !== undefined ? r.data.output : r.data;

        results[nodeId] = {
          input: nodeInput,
          output: normalizedOut,
          status: "ok"
        };
      } catch (err) {
        results[nodeId] = {
          input: nodeInput,
          output: null,
          status: "error",
          error: {
            message: err.message,
            status: err.response?.status,
            response: err.response?.data
          }
        };
      }
    }

    return res.json({ success: true, results });
  } catch (err) {
    console.error('Decentralized workflow run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// changeable
const port = process.env.PORT || 3111;
app.listen(port, () => console.log(`Runner listening on ${port}`));
