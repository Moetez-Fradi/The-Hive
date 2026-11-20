#!/usr/bin/env node
import axios from "axios";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import readline from "readline";
import dotenv from "dotenv";
import express from "express";
import Docker from "dockerode";
import localtunnel from "localtunnel";

dotenv.config();

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";
const NODE_FILE = process.env.NODE_FILE || "./node_keys.json";
const NODE_PORT = parseInt(process.env.NODE_PORT || "9000");
const USE_TUNNEL = process.env.USE_TUNNEL === "true";
const PUBLIC_HOST = process.env.NODE_PUBLIC_HOST || "localhost";

const docker = new Docker();
const containers = new Map();

function prompt(question, envValue) {
  if (envValue) return Promise.resolve(envValue);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  fs.writeFileSync(NODE_FILE, JSON.stringify({ publicKey, privateKey }, null, 2));
  console.log("Generated node key pair.");
  return { publicKey, privateKey };
}

async function login(email, password) {
  const { data } = await axios.post(`${BACKEND_URL}/auth/login`, { email, password });
  return data.access_token;
}

async function registerNode(token, publicKey, url, cpus, memGB) {
  const payload = { publicKey, capabilities: { cpus, memGB }, url };
  const { data } = await axios.post(`${BACKEND_URL}/nodes/register`, payload, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return data;
}

async function getNodeResources() {
  const totalCpus = os.cpus().length;
  const totalMemGB = os.totalmem() / 1024 / 1024 / 1024;
  console.log(`Your system has ${totalCpus} CPU cores and ${totalMemGB.toFixed(2)} GB RAM.`);
  let cpus = await prompt(`CPU cores to allocate (1-${totalCpus}): `, process.env.NODE_CPUS);
  cpus = Math.min(Math.max(parseInt(cpus) || 1, 1), totalCpus);
  let memGB = await prompt(`RAM to allocate in GB (0.5-${totalMemGB.toFixed(2)}): `, process.env.NODE_MEM_GB);
  memGB = Math.min(Math.max(parseFloat(memGB) || 0.5, 0.5), totalMemGB);
  return { cpus, memGB };
}

async function pullImage(image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {}
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res)));
    });
  });
}

async function startContainer(instanceId, image, envVars = {}) {
  await pullImage(image);
  const hostPort = 30000 + Math.floor(Math.random() * 10000);
  const container = await docker.createContainer({
    Image: image,
    Env: Object.entries(envVars).map(([k, v]) => `${k}=${v}`),
    ExposedPorts: { "80/tcp": {} },
    HostConfig: { PortBindings: { "80/tcp": [{ HostPort: hostPort.toString() }] }, AutoRemove: true },
  });
  await container.start();
  await waitForReady(`http://localhost:${hostPort}`);
  const tunnel = USE_TUNNEL ? await localtunnel({ port: hostPort }) : null;
  const url = tunnel ? tunnel.url : `http://${PUBLIC_HOST}:${hostPort}`;
  containers.set(instanceId, { container, url, tunnel });
  console.log(`Container ${instanceId} started at ${url}`);

  return { container, url };
}

async function waitForReady(baseUrl, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await axios.get(baseUrl, { timeout: 2000, validateStatus: () => true });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

async function startLocalTunnel(port) {
  if (!USE_TUNNEL) return `http://${PUBLIC_HOST}:${port}`;
  const tunnel = await localtunnel({ port });
  console.log(`Tunnel established: ${tunnel.url}`);
  tunnel.on("close", () => console.log("Tunnel closed."));
  return tunnel.url;
}

async function main() {
  try {
    const keys = fs.existsSync(NODE_FILE)
      ? JSON.parse(fs.readFileSync(NODE_FILE, "utf8"))
      : await generateKeyPair();

    const email = await prompt("Email: ", process.env.NODE_EMAIL);
    const password = await prompt("Password: ", process.env.NODE_PASSWORD);
    const token = await login(email, password);
    console.log("Logged in.");

    const { cpus, memGB } = await getNodeResources();

    const publicUrl = await startLocalTunnel(NODE_PORT);
    console.log(`Node public URL: ${publicUrl}`);

    const { node } = await registerNode(token, keys.publicKey, publicUrl, cpus, memGB);
    console.log(`Node registered: ${node.id} at ${publicUrl}`);

    const app = express();
    app.use(express.json());

    app.post("/start-container", async (req, res) => {
      try {
        const { instanceId, dockerImageUrl, env, token: oneTimeToken } = req.body;
        if (!instanceId || !dockerImageUrl)
          return res.status(400).json({ error: "instanceId & dockerImageUrl required" });
        if (!oneTimeToken) return res.status(401).json({ error: "one-time token required" });
        try {
          await axios.post(`${BACKEND_URL}/nodes/tokens/redeem`,
            { nodeId: node.id, token: oneTimeToken },
            { headers: { Authorization: `Bearer ${token}` } });
        } catch (err) {
          return res.status(401).json({ error: "one-time token rejected" });
        }
        const { url } = await startContainer(instanceId, dockerImageUrl, env || {});
        res.json({ success: true, usageUrl: url });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.post("/run-tool", async (req, res) => {
      try {
        const { instanceId, input = {} } = req.body;
        if (!containers.has(instanceId)) return res.status(404).json({ error: "Container not found" });
        const { container, url } = containers.get(instanceId);
        const result = await axios.post(`${url}/run`, input);
        res.json({ success: true, output: result.data });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    process.on("SIGINT", async () => {
      console.log("Node shutting down...");
      await axios.patch(`${BACKEND_URL}/nodes/status`,
        { nodeId: node.id, status: "OFFLINE" },
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(err => console.warn("Failed to update node status:", err.message));
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("Node shutting down...");
      await axios.patch(`${BACKEND_URL}/nodes/status`,
        { nodeId: node.id, status: "OFFLINE" },
        { headers: { Authorization: `Bearer ${token}` } }
      ).catch(err => console.warn("Failed to update node status:", err.message));
      process.exit(0);
    });

    setInterval(async () => {
      try {
        await axios.patch(`${BACKEND_URL}/nodes/status`,
          { nodeId: node.id, status: containers.size ? "BUSY" : "ONLINE" },
          { headers: { Authorization: `Bearer ${token}` } }
        );
      } catch (err) {
        console.warn("Failed to send heartbeat:", err.message);
      }
    }, 60000);


    app.listen(NODE_PORT, () => console.log(`Node listening on port ${NODE_PORT}`));
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  }
}

main();
