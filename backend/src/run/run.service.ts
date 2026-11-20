import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { HederaService } from '../hedera/hedera.service';
import { sha256 } from '../common/hash';
import { runnerBaseUrl, runnerHeaders } from '../common/runner';
import { openGraph } from '../workflow/graph-secrets';

type NodeResult = { status: string; output?: any; input?: any; error?: any };
type NodeAssignment = { nodeId: string; usageUrl: string };

const HASHSCAN = process.env.HASHSCAN_URL || 'https://hashscan.io/testnet';

@Injectable()
export class RunService {
  private readonly logger = new Logger(RunService.name);

  constructor(
    private prisma: PrismaService,
    private http: HttpService,
    private hedera: HederaService,
  ) {}

  static digest(workflowId: string, input: any, results: Record<string, NodeResult>, nodes: Record<string, string>) {
    const outputs = Object.fromEntries(
      Object.entries(results || {}).map(([id, r]) => [id, { status: r?.status ?? 'unknown', output: r?.output ?? null }]),
    );
    const inputHash = sha256(input ?? {});
    const outputHash = sha256(outputs);
    const runHash = sha256({ workflowId, inputHash, outputHash, nodes });
    return { inputHash, outputHash, runHash };
  }

  private async findPaidDeployment(workflowId: string) {
    const instances = await this.prisma.privateWorkflowInstance.findMany({
      where: { workflowId },
      select: { id: true, graphJson: true, nodeMap: true, usageUrl: true },
    });
    if (!instances.length) return null;
    const payment = await this.prisma.payment.findFirst({
      where: { instanceId: { in: instances.map(i => i.id) } },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;
    return { payment, instance: instances.find(i => i.id === payment.instanceId)! };
  }

  private async callRunner(usageUrl: string, input: any) {
    const resp = await lastValueFrom(
      this.http.post(usageUrl, { input }, { headers: runnerHeaders(), timeout: 120_000 }),
    );
    return resp.data;
  }

  private async redeploy(usageUrl: string, instance: { graphJson: any; nodeMap: any }) {
    const decentralized = usageUrl.match(/\/decentralized\/workflow\/([^/]+)\/run$/);
    const central = usageUrl.match(/\/workflow\/([^/]+)\/run$/);
    const graph = openGraph(instance.graphJson as any);

    if (decentralized && instance.nodeMap) {
      const mapping = Object.fromEntries(
        Object.entries(instance.nodeMap as Record<string, NodeAssignment>).map(([id, a]) => [id, a.usageUrl]),
      );
      await lastValueFrom(this.http.post(`${runnerBaseUrl()}/register-decentralized`,
        { instanceId: decentralized[1], graphJson: graph, mapping }, { headers: runnerHeaders() }));
      return;
    }
    if (central) {
      await lastValueFrom(this.http.post(`${runnerBaseUrl()}/run-workflow-and-test`,
        { instanceId: central[1], graphJson: graph, tests: [] }, { headers: runnerHeaders(), timeout: 300_000 }));
      return;
    }
    throw new Error('Cannot redeploy this workflow');
  }

  async run(userId: string, workflowId: string, input: Record<string, any>) {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    if (wf.workflowStatus !== 'DEPLOYED' || !wf.usageUrl) {
      throw new BadRequestException('This workflow is not deployed yet');
    }

    const deployment = await this.findPaidDeployment(workflowId);
    if (!deployment) throw new HttpException('This workflow has no deployment receipt', HttpStatus.PAYMENT_REQUIRED);
    if (!deployment.payment.paid && deployment.payment.total > 0) {
      throw new HttpException(
        { message: 'Deployment payment has not been verified on Hedera yet', paymentId: deployment.payment.id },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const started = Date.now();
    let data: any;
    try {
      data = await this.callRunner(wf.usageUrl, input);
    } catch (err: any) {
      if (err?.response?.status !== 404) {
        throw new HttpException(`Runner failed: ${err?.response?.data?.error ?? err.message}`, HttpStatus.BAD_GATEWAY);
      }
      this.logger.warn(`Runner lost workflow ${workflowId}, redeploying`);
      await this.redeploy(wf.usageUrl, deployment.instance);
      data = await this.callRunner(wf.usageUrl, input);
    }
    const runtimeMs = Date.now() - started;

    const results: Record<string, NodeResult> = data?.results ?? {};
    const statuses = Object.values(results).map(r => r.status);
    const status = statuses.every(s => s === 'ok' || s === 'skipped') ? 'ok' : statuses.some(s => s === 'ok') ? 'partial' : 'failed';

    const nodeMap = (deployment.instance.nodeMap ?? {}) as Record<string, NodeAssignment>;
    const mode = Object.keys(nodeMap).length ? 'decentralized' : 'hive-runner';
    const nodes = Object.fromEntries(
      Object.keys(results).map(id => [id, nodeMap[id]?.nodeId ?? 'hive-runner']),
    );
    const hashes = RunService.digest(workflowId, input, results, nodes);

    const run = await this.prisma.workflowRun.create({
      data: { workflowId, userId, mode, status, input, results: results as any, nodes, runtimeMs, ...hashes },
    });

    await this.recordUsage(wf.graphJson as any, results, nodeMap);
    const proof = await this.anchor(run.id, workflowId, mode, status, hashes, nodes);

    return { runId: run.id, status, mode, runtimeMs, results, proof: { ...hashes, ...proof } };
  }

  private async anchor(runId: string, workflowId: string, mode: string, status: string, hashes: any, nodes: any) {
    if (!this.hedera.isConfigured()) return null;
    try {
      const receipt = await this.hedera.submitAudit({
        v: 1,
        app: 'AgentHive',
        type: 'workflow-run',
        runId,
        workflowId,
        mode,
        status,
        nodes,
        ...hashes,
      });
      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: { hcsTopicId: receipt.topicId, hcsSequence: receipt.sequenceNumber, hcsTxId: receipt.transactionId },
      });
      return { ...receipt, ...RunService.links(receipt.topicId, receipt.sequenceNumber, receipt.transactionId) };
    } catch (err: any) {
      this.logger.error(`HCS anchoring failed for run ${runId}: ${err?.message || err}`);
      return null;
    }
  }

  static links(topicId: string, sequenceNumber: number, transactionId?: string | null) {
    return {
      topicUrl: `${HASHSCAN}/topic/${topicId}`,
      messageUrl: `${HASHSCAN}/topic/${topicId}/message/${sequenceNumber}`,
      transactionUrl: transactionId ? `${HASHSCAN}/transaction/${HederaService.toMirrorTxId(transactionId)}` : null,
    };
  }

  private async recordUsage(graph: any, results: Record<string, NodeResult>, nodeMap: Record<string, NodeAssignment>) {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) {
      if (results[node.id]?.status === 'ok') counts.set(node.toolId, (counts.get(node.toolId) ?? 0) + 1);
    }
    await Promise.all(
      [...counts].map(([id, n]) => this.prisma.tool.update({ where: { id }, data: { usageCount: { increment: n } } }).catch(() => null)),
    );

    for (const [graphNodeId, a] of Object.entries(nodeMap)) {
      const result = results[graphNodeId];
      if (!result || result.status === 'skipped') continue;
      const node = await this.prisma.node.findUnique({ where: { id: a.nodeId } });
      if (!node) continue;
      const reputation = Number((0.9 * node.reputation + 0.1 * (result.status === 'ok' ? 1 : 0)).toFixed(4));
      await this.prisma.node.update({ where: { id: node.id }, data: { reputation } });
    }
  }

  async get(runId: string) {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');
    return this.present(run);
  }

  async list(workflowId: string, limit = 20) {
    const runs = await this.prisma.workflowRun.findMany({
      where: { workflowId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
    });
    return runs.map(r => this.present(r));
  }

  private present(run: any) {
    return {
      ...run,
      links: run.hcsTopicId ? RunService.links(run.hcsTopicId, run.hcsSequence, run.hcsTxId) : null,
    };
  }

  async verify(runId: string) {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Run not found');

    const recomputed = RunService.digest(run.workflowId, run.input, run.results as any, (run.nodes as any) ?? {});

    if (!run.hcsTopicId || run.hcsSequence == null) {
      return { verified: false, reason: 'Run was not anchored on Hedera', recomputed };
    }
    const msg = await this.hedera.getTopicMessage(run.hcsTopicId, run.hcsSequence);
    if (!msg) return { verified: false, reason: 'Message not found on the mirror node yet', recomputed };

    let onChain: any = null;
    try {
      onChain = JSON.parse(msg.message);
    } catch {
      return { verified: false, reason: 'Anchored message is not valid JSON', recomputed };
    }

    const checks = {
      runId: onChain.runId === run.id,
      inputHash: onChain.inputHash === recomputed.inputHash,
      outputHash: onChain.outputHash === recomputed.outputHash,
      runHash: onChain.runHash === recomputed.runHash,
    };
    const verified = Object.values(checks).every(Boolean);
    if (verified && !run.consensusAt) {
      await this.prisma.workflowRun.update({ where: { id: run.id }, data: { consensusAt: msg.consensusTimestamp } });
    }
    return {
      verified,
      reason: verified ? 'Stored input and outputs match the hashes anchored on Hedera' : 'Stored data does not match the anchored hashes',
      checks,
      recomputed,
      onChain,
      consensusTimestamp: msg.consensusTimestamp,
      links: RunService.links(run.hcsTopicId, run.hcsSequence, run.hcsTxId),
    };
  }
}
