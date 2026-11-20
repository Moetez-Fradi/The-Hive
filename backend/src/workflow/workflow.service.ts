import { Injectable, BadRequestException, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { HederaService } from '../hedera/hedera.service';
import { runnerHeaders } from '../common/runner';
import { openGraph, publicGraph, sealGraph, withStoredSecrets } from './graph-secrets';

const OWNER_FIELDS = { id: true, displayName: true, walletAccountId: true } as const;


@Injectable()
export class WorkflowService {
  constructor(private prisma: PrismaService, private httpService: HttpService, private hederaService: HederaService) {}

  private async enrichGraphWithTools(graphJson: any) {
    if (!graphJson?.nodes?.length) throw new BadRequestException('Invalid graph');
    graphJson = openGraph(graphJson);

    const toolIds = graphJson.nodes.map(n => n.toolId);
    const tools = await this.prisma.tool.findMany({ where: { id: { in: toolIds } } });
    const toolById = new Map(tools.map(t => [t.id, t]));

    const missing = toolIds.filter(id => !toolById.has(id));
    if (missing.length) throw new BadRequestException(`Tools not found: ${missing.join(',')}`);

    const notDeployed = tools.filter(t => t.status !== 'DEPLOYED');
    if (notDeployed.length) {
      throw new BadRequestException(
        `All tools must be DEPLOYED. Not deployed: ${notDeployed.map(t => t.name || t.id).join(', ')}`,
      );
    }

    const nodes = graphJson.nodes.map((n: any) => {
      const tool = toolById.get(n.toolId);
      return {
        ...n,
        dockerImageUrl: tool?.dockerImageUrl,
        usagePrice: tool?.usagePrice ?? 0,
        ownerAccountId: tool?.ownerWallet ?? '',
      };
    });

    return { nodes, edges: graphJson.edges ?? [] };
  }

  private async fallbackToLocalRunner(workflowId, enriched, tests, userId) {
    const runnerUrl = process.env.WORKFLOW_DEPLOYER_URL || 'http://localhost:3111/run-workflow-and-test';
    let resp;
    try {
      resp = await lastValueFrom(this.httpService.post(runnerUrl, {
        instanceId: `${workflowId}-deploytest-${Date.now().toString(36)}`,
        graphJson: { nodes: enriched.nodes, edges: enriched.edges },
        tests,
      }, { headers: runnerHeaders(), timeout: 300_000 }));
    } catch (e) {
      throw new InternalServerErrorException('Failed to contact workflow test runner');
    }
    const data = resp?.data;
    if (!data) throw new InternalServerErrorException('Empty response from runner');
    if (!data.success) return { success: false, reason: 'tests_failed', details: data };
    await this.prisma.workflow.update({
      where: { id: workflowId },
      data: { workflowStatus: 'DEPLOYED', usageUrl: data.workflowUsageUrl },
    });
    const created = await this.prisma.privateWorkflowInstance.create({
      data: { ownerUserId: userId, workflowId, graphJson: sealGraph(enriched), usageUrl: data.workflowUsageUrl },
    });

    const { receipt, payment } = await this.createDeploymentPayment(userId, created.id, workflowId, enriched);
    return {
      success: true,
      mode: 'fallback',
      instanceId: created.id,
      usageUrl: data.workflowUsageUrl,
      testReport: data,
      receipt,
      paymentId: payment.id,
    };
  }

  private async createDeploymentPayment(
    userId: string,
    instanceId: string,
    workflowId: string,
    enriched: any,
    compute: Array<{ receiver: string; toolName: string; amount: number }> = [],
  ) {
    const payer = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { walletAccountId: true },
    });
    if (!payer?.walletAccountId) throw new BadRequestException('Link a Hedera wallet before deploying');

    const receipt = (enriched.nodes || [])
      .filter((node: any) => node.ownerAccountId && Number(node.usagePrice) > 0)
      .map((node: any) => ({
        receiver: node.ownerAccountId,
        toolName: node.name,
        amount: Number(node.usagePrice),
      }))
      .concat(compute.filter(c => c.receiver && c.amount > 0));
    const total = receipt.reduce((sum: number, r: any) => sum + r.amount, 0);
    const memo = `AgentHive deploy ${instanceId}`;

    const payment = await this.prisma.payment.upsert({
      where: { instanceId },
      update: { payer: payer.walletAccountId, receipt, total, paid: false, memo },
      create: { instanceId, payer: payer.walletAccountId, receipt, total, paid: false, memo },
    });
    return { receipt, payment };
  }

  async createWorkflow(userId: string, wallet: string, graphJson: any, name?: string, fixedUsageFee?: number, description?: string) {
    if (!graphJson?.nodes?.length) throw new BadRequestException('Invalid graph');

    const toolIds = graphJson.nodes.map(n => n.toolId);
    const tools = await this.prisma.tool.findMany({ where: { id: { in: toolIds } } });
    const priceById = new Map(tools.map(t => [t.id, t.usagePrice ?? 0]));
    const estimatedCost = toolIds.reduce((acc, id) => acc + (priceById.get(id) ?? 0), 0);

    const energyEstimate = tools.reduce((acc, t) =>
      acc + (t.energyBaseline ?? 0), 0
    );

    const workflow = await this.prisma.workflow.create({
      data: {
        name: name,
        description: description,
        ownerUserId: userId,
        graphJson: sealGraph(graphJson),
        fixedUsageFee: fixedUsageFee ?? 0,
        estimatedCost,
        energyEstimate,
      },
    });

    return { success: true, workflow };
  }

  async findById(id: string) {
    const wf = await this.prisma.workflow.findUnique({
      where: { id },
      include: { owner: { select: OWNER_FIELDS } },
    });
    if (!wf) throw new NotFoundException('Workflow not found');
    return { ...wf, graphJson: publicGraph(wf.graphJson as any) };
  }

  async deleteWorkflow(id: string, requestingUserId: string) {
    const wf = await this.prisma.workflow.findUnique({ where: { id } });
    if (!wf) throw new NotFoundException('Workflow not found');
    if (wf.ownerUserId !== requestingUserId) throw new ForbiddenException('Only owner can delete workflow');
    await this.prisma.workflow.delete({ where: { id } });
    return { success: true };
  }

  async testWorkflow(userId: string, workflowId: string, graphJson: any) {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    if (wf.ownerUserId !== userId) throw new ForbiddenException('Only owner can test workflow');

    const payloadGraph = withStoredSecrets(graphJson ?? wf.graphJson, wf.graphJson as any);
    const enriched = await this.enrichGraphWithTools(payloadGraph);

    const runnerUrl = process.env.WORKFLOW_RUNNER_URL || 'http://localhost:3111/run-workflow';
    const instanceId = `${workflowId}-test-${Date.now().toString(36)}`;

    let resp;
    try {
      resp = await lastValueFrom(this.httpService.post(runnerUrl, {
        instanceId,
        graphJson: { nodes: enriched.nodes, edges: enriched.edges },
      }, { headers: runnerHeaders(), timeout: 300_000 }));
    } catch (e) {
      throw new InternalServerErrorException('Failed to contact workflow runner');
    }

    const data = resp?.data;
    if (!data) throw new InternalServerErrorException('Empty response from runner');

    if (!data.usageUrl) {
      return { success: false, deployed: false, pending: true, instanceId };
    }

    const created = await this.prisma.privateWorkflowInstance.create({
      data: { ownerUserId: userId, graphJson: sealGraph(openGraph(payloadGraph)), usageUrl: data.usageUrl, workflowId: wf.id },
    });

    return { success: true, deployed: false, workflow: wf.id, instance: created.id, usageUrl: data.usageUrl };
  }

  async runDeployTests(userId: string, workflowId: string, graphJson: any, tests: Array<any>) {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    if (wf.ownerUserId !== userId) throw new ForbiddenException('Only owner can deploy');
    const deployer = await this.prisma.user.findUnique({ where: { id: userId }, select: { walletAccountId: true } });
    if (!deployer?.walletAccountId) throw new BadRequestException('Link a Hedera wallet before deploying');

    const payloadGraph = withStoredSecrets(graphJson ?? wf.graphJson, wf.graphJson as any);
    const enriched = await this.enrichGraphWithTools(payloadGraph);
    const requiredCount = enriched.nodes.length;

    const freshSince = new Date(Date.now() - 3 * 60 * 1000);
    const availableNodes = await this.prisma.node.findMany({
      where: { status: 'ONLINE', lastSeenAt: { gte: freshSince } },
      orderBy: [{ reputation: 'desc' }, { lastSeenAt: 'desc' }],
      include: { owner: { select: { walletAccountId: true } } },
    });
    if (availableNodes.length < requiredCount) {
      console.log(`Only ${availableNodes.length}/${requiredCount} nodes online, falling back to local runner`);
      return await this.fallbackToLocalRunner(workflowId, enriched, tests, userId);
    }
    const selectedNodes = availableNodes.slice(0, requiredCount);

  try {
    await this.prisma.$transaction(
      selectedNodes.map(n => this.prisma.node.update({
        where: { id: n.id },
        data: { status: 'BUSY' },
      }))
    );

    const deployments: { nodeId: string; usageUrl: string; ownerWallet: string | null }[] = [];

    for (let i = 0; i < selectedNodes.length; i++) {
      const node = selectedNodes[i];
      const nodeSpec = enriched.nodes[i];

      console.log(`Deploying to node ${node.id} at ${node.url}`);

      const jti = uuidv4();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
      await this.prisma.oneTimeToken.create({
        data: {
          jti,
          taskId: `${workflowId}-deploy-${Date.now().toString(36)}-${i}`,
          nodeId: node.id,
          expiresAt,
        },
      });

      const deployUrl = `${node.url.replace(/\/$/, '')}/start-container`;
      try {
        const resp = await lastValueFrom(this.httpService.post(
          deployUrl,
          {
            instanceId: `${workflowId}-${nodeSpec.id}`,
            dockerImageUrl: nodeSpec.dockerImageUrl,
            env: nodeSpec.env || {},
            token: jti,
          },
          { timeout: 60_000 }
        ));

        const usageUrl = resp.data?.usageUrl;
        if (!usageUrl) throw new Error('Missing usageUrl from node');

        deployments.push({ nodeId: node.id, usageUrl, ownerWallet: node.owner?.walletAccountId ?? null });
      } catch (err) {
        throw new Error(`Failed to deploy on node ${node.id}: ${err?.message || err}`);
      }
    }

    const mapping: Record<string, string> = {};
    const nodeMap: Record<string, { nodeId: string; usageUrl: string }> = {};
    enriched.nodes.forEach((n, idx) => {
      mapping[n.id] = deployments[idx].usageUrl;
      nodeMap[n.id] = { nodeId: deployments[idx].nodeId, usageUrl: deployments[idx].usageUrl };
    });
    const computeFee = Number(process.env.NODE_COMPUTE_FEE_HBAR ?? 0.1);
    const compute = deployments.map((d, idx) => ({
      receiver: d.ownerWallet ?? '',
      toolName: `Compute for ${enriched.nodes[idx].name ?? enriched.nodes[idx].id} on node ${d.nodeId.slice(-6)}`,
      amount: computeFee,
    }));

    const runnerUrl = process.env.WORKFLOW_DECENTRALIZED_RUNNER_URL || 'http://localhost:3111/register-decentralized';
    const registerResp = await lastValueFrom(this.httpService.post(runnerUrl, {
      instanceId: `${workflowId}-deploytest-${Date.now().toString(36)}`,
      graphJson: enriched,
      mapping,
      tests,
    }, { headers: runnerHeaders() }));

    const data = registerResp.data;
    if (!data || !data.workflowUsageUrl) throw new InternalServerErrorException('Runner failed to register decentralized workflow');

    await this.prisma.workflow.update({
      where: { id: workflowId },
      data: { workflowStatus: 'DEPLOYED', usageUrl: data.workflowUsageUrl },
    });

    const created = await this.prisma.privateWorkflowInstance.create({
      data: {
        workflowId: workflowId,
        ownerUserId: userId,
        graphJson: sealGraph(openGraph(payloadGraph)),
        usageUrl: data.workflowUsageUrl,
        nodeMap,
      },
    });

    await this.prisma.privateWorkflowInstance.deleteMany({
      where: {
        AND: [
          { id: { not: created.id } },
          {
            OR: [
              { workflowId: workflowId },
              { usageUrl: data.workflowUsageUrl },
            ]
          }
        ]
      }
    });

    const { receipt, payment } = await this.createDeploymentPayment(userId, created.id, workflowId, enriched, compute);

    return {
      success: true,
      mode: 'decentralized',
      workflow: workflowId,
      instanceId: created.id,
      usageUrl: data.workflowUsageUrl,
      mapping,
      runnerReport: data,
      createdInstanceId: created.id,
      receipt,
      paymentId: payment.id,
    };

  } catch (err) {
    await Promise.all(selectedNodes.map(async n => {
      try { await this.prisma.node.update({ where: { id: n.id }, data: { status: 'ONLINE' } }); } catch {}
    }));
    await this.prisma.oneTimeToken.deleteMany({
      where: { nodeId: { in: selectedNodes.map(n => n.id) }, used: false }
    }).catch(()=>{});
    throw new InternalServerErrorException(err.message || String(err));
  }
  }

  async listWorkflows(page = 1, limit = 10) {
    const items = await this.prisma.workflow.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { owner: { select: { displayName: true } } },
    });
    const total = await this.prisma.workflow.count();
    return { workflows: items.map(w => ({ ...w, graphJson: publicGraph(w.graphJson as any) })), total, page, limit };
  }

  async searchWorkflows(query: string, limit = 10) {
    if (!query) return [];

    const normalizedQuery = query.trim();

    const items = await this.prisma.workflow.findMany({
      where: {
        OR: [
          { name: { contains: normalizedQuery, mode: 'insensitive' } },
          { description: { contains: normalizedQuery, mode: 'insensitive' } },
        ],
      },
      include: { owner: { select: { displayName: true } } },
      take: limit,
    });

    return items.map(w => ({ ...w, graphJson: publicGraph(w.graphJson as any) }));
  }
}
