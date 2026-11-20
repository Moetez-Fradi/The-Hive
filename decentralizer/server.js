import express from "express";
import dotenv from "dotenv";
import { decryptEnv } from "./utils/decrypt.js";
import { pullImage, waitForReady } from "./utils/docker.js";
import { evaluateCondition } from "./utils/condition.js";
import Docker from "dockerode";
import axios from "axios";
import cors from "cors";

const docker = new Docker();
dotenv.config();
const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "x-runner-key"],
}));

const RUNNER_TOKEN = process.env.RUNNER_TOKEN;
app.use((req, res, next) => {
  if (!RUNNER_TOKEN || req.method !== "POST") return next();
  if (req.get("x-runner-key") !== RUNNER_TOKEN) return res.status(401).json({ error: "Missing or invalid runner key" });
  next();
});

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
    await waitForReady(`http://localhost:${hostPort}`);
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

function parseShape(shape) {
  if (!shape || typeof shape !== "string") return shape && typeof shape === "object" ? shape : null;
  try {
    const parsed = JSON.parse(shape);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

app.post("/run-and-test", async (req, res) => {
  try {
    const { instanceId, dockerImageUrl, envCipher, tests = [] } = req.body;
    if (!instanceId || !dockerImageUrl || !envCipher)
      return res.status(400).json({ error: "instanceId, dockerImageUrl, envCipher required" });

    const envVars = decryptEnv(envCipher);
    await pullImage(dockerImageUrl);

    const hostPort = 30000 + Math.floor(Math.random() * 10000);

    const container = await docker.createContainer({
      Image: dockerImageUrl,
      Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
      ExposedPorts: { "80/tcp": {} },
      HostConfig: { PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] }, AutoRemove: true },
      name: `tool_${instanceId}`,
    });

    await container.start();
    const baseUrl = `http://localhost:${hostPort}`;
    await waitForReady(baseUrl);

    const results = [];
    let totalMs = 0;
    let totalOutBytes = 0;
    let totalMemMB = 0;

    let inputShape = req.body.inputShape;
    let outputShape = req.body.outputShape;

  for (const t of tests) {
    const expectedShape = parseShape(outputShape);

    const input = t.input;

    const expected = t.expected;
    let out, duration, memUsage;

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
const decentralizedStore = new Map();
const TEST_INSTANCE_TTL_MS = 25 * 60 * 1000;

function topoSortNodes(nodes = [], edges = []) {
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const ad = new Map(nodes.map(n => [n.id, []]));
  edges.forEach(e => {
    if (!ad.has(e.from) || !indeg.has(e.to)) return;
    ad.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
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
  if (order.length !== nodes.length) throw new Error("Workflow graph has a cycle");
  return order;
}

const getByPath = (obj, path) => path?.split(".").map(p => p.trim()).reduce((acc, key) => acc?.[key], obj);

const interpolateTemplate = (tpl, ctx) =>
  tpl.replace(/\{\{(.*?)\}\}/g, (_, expr) => {
    const val = getByPath(ctx, expr.trim());
    if (val == null) return "";
    return typeof val === "object" ? JSON.stringify(val) : String(val);
  });

function deriveEdges(graphJson) {
  const nodes = graphJson.nodes || [];
  if (graphJson.edges?.length || !nodes.some(n => n.inputs?.length)) return graphJson.edges || [];
  const edges = [];
  for (const node of nodes) {
    for (const inp of node.inputs || []) {
      if (!inp.source) continue;
      const sourcePath = inp.path ? `${inp.source}.${inp.path}` : inp.source;
      edges.push({ from: inp.source, to: node.id, mapping: { [inp.name]: `{{${sourcePath}}}` }, condition: inp.condition || null });
    }
  }
  return edges;
}

async function executeGraph(graphJson, resolveUrl, globalInput = {}) {
  const nodes = graphJson.nodes || [];
  const edges = deriveEdges(graphJson);
  const order = topoSortNodes(nodes, edges);
  const results = {};

  for (const nodeId of order) {
    const incoming = edges.filter(e => e.to === nodeId);
    let nodeInput = {};

    if (incoming.length === 0) {
      nodeInput = { ...globalInput };
    } else {
      for (const e of incoming) {
        const from = results[e.from];
        if (!from || from.status !== "ok") continue;
        const context = { ...globalInput, ...(from.input || {}), ...(from.output || {}) };
        let passed;
        try {
          passed = evaluateCondition(e.condition, context);
        } catch (err) {
          results[nodeId] = { input: {}, output: null, status: "error", error: { message: `Invalid condition: ${err.message}` } };
          break;
        }
        if (!passed) continue;
        const mapping = e.mapping && Object.keys(e.mapping).length ? e.mapping : null;
        const mapped = mapping
          ? Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, typeof v === "string" ? interpolateTemplate(v, context) : v]))
          : { ...(from.output || {}) };
        Object.assign(nodeInput, mapped);
      }
      if (results[nodeId]) continue;
    }

    if (Object.keys(nodeInput).length === 0 && incoming.length > 0) {
      results[nodeId] = { input: {}, output: null, status: "skipped", reason: "no incoming edge matched" };
      continue;
    }

    const url = resolveUrl(nodeId);
    if (!url) {
      results[nodeId] = { input: nodeInput, output: null, status: "error", error: { message: `No running container for ${nodeId}` } };
      continue;
    }

    const started = Date.now();
    try {
      const r = await axios.post(`${url.replace(/\/$/, "")}/run`, nodeInput, { timeout: 30000 });
      const output = r.data && r.data.output !== undefined ? r.data.output : r.data;
      results[nodeId] = { input: nodeInput, output, status: "ok", ms: Date.now() - started };
    } catch (err) {
      results[nodeId] = {
        input: nodeInput,
        output: null,
        status: "error",
        ms: Date.now() - started,
        error: { message: err.message, status: err.response?.status, response: err.response?.data },
      };
    }
  }
  return results;
}

async function removeContainerIfExists(name) {
  try {
    const existing = docker.getContainer(name);
    await existing.remove({ force: true });
  } catch {}
}

async function startWorkflowContainers(instanceId, nodes, fallbackEnv = {}) {
  const containers = {};
  try {
    for (const node of nodes) {
      await pullImage(node.dockerImageUrl);
      const hostPort = 30000 + Math.floor(Math.random() * 10000);
      const env = node.env && Object.keys(node.env).length ? node.env : fallbackEnv;
      const name = `${instanceId}_${node.id}`;
      await removeContainerIfExists(name);
      const container = await docker.createContainer({
        Image: node.dockerImageUrl,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { "80/tcp": {} },
        HostConfig: { PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] }, AutoRemove: true },
        name,
      });
      await container.start();
      const usageUrl = `http://localhost:${hostPort}`;
      containers[node.id] = { container, usageUrl };
      await waitForReady(usageUrl);
      console.log(`Node ${node.name ?? node.id} running at ${usageUrl}`);
    }
  } catch (err) {
    await stopContainers(containers);
    throw err;
  }
  return containers;
}

async function stopContainers(containers) {
  await Promise.all(Object.values(containers).map(c => c.container.stop().catch(() => {})));
}

async function replaceWorkflow(instanceId, entry) {
  const previous = workflowStore.get(instanceId);
  if (previous) {
    clearTimeout(previous.timer);
    await stopContainers(previous.containers);
  }
  workflowStore.set(instanceId, entry);
}

function publicUrl(req, path) {
  return `${process.env.RUNNER_PUBLIC_URL?.replace(/\/$/, "") || `${req.protocol}://${req.get("host")}`}${path}`;
}

app.post("/run-workflow", async (req, res) => {
  try {
    const { instanceId, graphJson, envCipher } = req.body;
    if (!instanceId || !graphJson) return res.status(400).json({ error: "instanceId and graphJson required" });

    const envVars = envCipher ? decryptEnv(envCipher) : {};
    const containers = await startWorkflowContainers(instanceId, graphJson.nodes, envVars);
    const timer = setTimeout(async () => {
      await stopContainers(containers);
      workflowStore.delete(instanceId);
      console.log(`Test workflow ${instanceId} stopped after 25 minutes`);
    }, TEST_INSTANCE_TTL_MS);

    await replaceWorkflow(instanceId, { graphJson, containers, timer });
    res.json({ usageUrl: publicUrl(req, `/workflow/${instanceId}/run`) });
  } catch (e) {
    console.error("run-workflow error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/workflow/:instanceId/run", async (req, res) => {
  try {
    const wf = workflowStore.get(req.params.instanceId);
    if (!wf) return res.status(404).json({ error: "Workflow instance not found" });
    const { input = {} } = req.body;
    const results = await executeGraph(wf.graphJson, id => wf.containers[id]?.usageUrl, input);
    res.json({ success: true, results });
  } catch (e) {
    console.error("workflow run error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/run-workflow-and-test", async (req, res) => {
  try {
    const { instanceId, graphJson, envCipher, tests = [], globalInput = {} } = req.body;
    if (!instanceId || !graphJson) return res.status(400).json({ error: "instanceId and graphJson required" });

    const envVars = envCipher ? decryptEnv(envCipher) : {};
    const containers = await startWorkflowContainers(instanceId, graphJson.nodes, envVars);
    await replaceWorkflow(instanceId, { graphJson, containers, timer: null });

    const resolve = id => containers[id]?.usageUrl;
    const results = {};
    for (const [i, test] of tests.entries()) {
      results[test.name || `test_${i}`] = await executeGraph(graphJson, resolve, { ...globalInput, ...(test.input || {}) });
    }

    res.json({
      success: true,
      workflowUsageUrl: publicUrl(req, `/workflow/${instanceId}/run`),
      containers: Object.fromEntries(Object.entries(containers).map(([id, c]) => [id, c.usageUrl])),
      results,
    });
  } catch (e) {
    console.error("run-workflow-and-test error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/register-decentralized", (req, res) => {
  const { instanceId, graphJson, mapping, tests = [] } = req.body;
  if (!instanceId || !graphJson || !mapping) return res.status(400).json({ error: "instanceId, graphJson, mapping required" });
  decentralizedStore.set(instanceId, { graphJson, mapping, tests });
  res.json({ success: true, workflowUsageUrl: publicUrl(req, `/decentralized/workflow/${instanceId}/run`) });
});

app.post("/decentralized/workflow/:instanceId/run", async (req, res) => {
  try {
    const wf = decentralizedStore.get(req.params.instanceId);
    if (!wf) return res.status(404).json({ error: "Workflow not found" });
    const { input = {} } = req.body;
    const results = await executeGraph(wf.graphJson, id => wf.mapping[id], input);
    res.json({ success: true, results });
  } catch (err) {
    console.error("Decentralized workflow run error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", workflows: workflowStore.size, decentralized: decentralizedStore.size });
});

const port = process.env.PORT || 3111;
app.listen(port, () => console.log(`Runner listening on ${port}${RUNNER_TOKEN ? " (token required)" : ""}`));
