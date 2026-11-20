import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { sealGraph } from '../src/workflow/graph-secrets';

type SeedData = {
  users: Array<{ email: string; password: string; displayName: string; walletAccountId?: string }>;
  tools: Array<{
    ownerEmail: string;
    name: string;
    description: string;
    dockerImageUrl: string;
    usagePrice: number;
    requiredEnv?: string[];
    inputShape?: string;
    outputShape?: string;
    usageCount?: number;
  }>;
  workflows: Array<{
    ownerEmail: string;
    name: string;
    description: string;
    fixedUsageFee?: number;
    steps: Array<{ tool: string; env?: Record<string, string> }>;
    edges?: Array<{ from: number; to: number; mapping: Record<string, string>; condition?: string }>;
  }>;
  reviews?: Array<{ userEmail: string; tool: string; stars: number; comment?: string }>;
};

const prisma = new PrismaClient();

function resolveEnv(env: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [k, v.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')]),
  );
}

async function main() {
  const file = process.argv[2] || path.join(__dirname, 'seed-data.json');
  const data: SeedData = JSON.parse(fs.readFileSync(file, 'utf8'));

  const userIdByEmail = new Map<string, string>();
  const walletByEmail = new Map<string, string | null>();
  for (const u of data.users) {
    const password = await bcrypt.hash(u.password, 10);
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: { displayName: u.displayName, walletAccountId: u.walletAccountId ?? null, password },
      create: { email: u.email, password, displayName: u.displayName, walletAccountId: u.walletAccountId ?? null },
    });
    userIdByEmail.set(u.email, user.id);
    walletByEmail.set(u.email, user.walletAccountId);
  }

  const toolIdByName = new Map<string, string>();
  for (const t of data.tools) {
    const ownerWallet = walletByEmail.get(t.ownerEmail);
    if (!ownerWallet) throw new Error(`Tool "${t.name}": owner ${t.ownerEmail} needs a walletAccountId`);
    const fields = {
      description: t.description,
      dockerImageUrl: t.dockerImageUrl,
      ownerWallet,
      usagePrice: t.usagePrice,
      requiredEnv: t.requiredEnv ?? [],
      inputShape: t.inputShape ?? 'Not specified',
      outputShape: t.outputShape ?? 'Not specified',
      usageCount: t.usageCount ?? 0,
      status: 'DEPLOYED' as const,
    };
    const existing = await prisma.tool.findFirst({ where: { name: t.name, ownerWallet } });
    const tool = existing
      ? await prisma.tool.update({ where: { id: existing.id }, data: fields })
      : await prisma.tool.create({ data: { name: t.name, ...fields } });
    toolIdByName.set(t.name, tool.id);
  }

  for (const w of data.workflows) {
    const ownerUserId = userIdByEmail.get(w.ownerEmail);
    if (!ownerUserId) throw new Error(`Workflow "${w.name}": unknown owner ${w.ownerEmail}`);
    const nodes = w.steps.map((s, i) => {
      const toolId = toolIdByName.get(s.tool);
      if (!toolId) throw new Error(`Workflow "${w.name}": unknown tool ${s.tool}`);
      return { id: `node_${i + 1}`, name: s.tool, toolId, env: resolveEnv(s.env ?? {}) };
    });
    const edges = (w.edges ?? []).map(e => ({
      from: `node_${e.from + 1}`,
      to: `node_${e.to + 1}`,
      mapping: e.mapping,
      condition: e.condition,
    }));
    const tools = await prisma.tool.findMany({ where: { id: { in: nodes.map(n => n.toolId) } } });
    const priceById = new Map(tools.map(t => [t.id, t.usagePrice ?? 0]));
    const estimatedCost = nodes.reduce((s, n) => s + (priceById.get(n.toolId) ?? 0), 0);
    const graphJson = sealGraph({ nodes, edges }) as any;
    await prisma.workflow.upsert({
      where: { ownerUserId_name: { ownerUserId, name: w.name } },
      update: { description: w.description, graphJson, fixedUsageFee: w.fixedUsageFee ?? 0, estimatedCost },
      create: {
        ownerUserId,
        name: w.name,
        description: w.description,
        graphJson,
        fixedUsageFee: w.fixedUsageFee ?? 0,
        estimatedCost,
      },
    });
  }

  for (const r of data.reviews ?? []) {
    const userId = userIdByEmail.get(r.userEmail);
    const toolId = toolIdByName.get(r.tool);
    if (!userId || !toolId) throw new Error(`Review by ${r.userEmail} on ${r.tool}: unknown user or tool`);
    const existing = await prisma.review.findFirst({ where: { userId, toolId } });
    if (existing) await prisma.review.update({ where: { id: existing.id }, data: { stars: r.stars, comment: r.comment ?? null } });
    else await prisma.review.create({ data: { userId, toolId, stars: r.stars, comment: r.comment ?? null } });
  }
  for (const toolId of toolIdByName.values()) {
    const avg = await prisma.review.aggregate({ where: { toolId }, _avg: { stars: true } });
    await prisma.tool.update({ where: { id: toolId }, data: { rating: avg._avg.stars ?? 0 } });
  }

  console.log(`Seeded ${data.users.length} users, ${data.tools.length} tools, ${data.workflows.length} workflows, ${data.reviews?.length ?? 0} reviews`);
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
