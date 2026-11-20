import { Injectable, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { runnerHeaders } from '../common/runner';
import { openGraph, publicGraph, sealGraph, withStoredSecrets } from '../workflow/graph-secrets';

@Injectable()
export class PrivateWorkflowInstanceService {
  constructor(private prisma: PrismaService, private httpService: HttpService) {}

  private present<T extends { graphJson: any; nodeMap?: any }>(inst: T) {
    const { nodeMap, ...rest } = inst as any;
    return { ...rest, graphJson: publicGraph(inst.graphJson) };
  }

  async createInstance(userId: string, workflowId: string, graphJson: any) {
    const wf = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    if (wf.ownerUserId !== userId) throw new ForbiddenException('Only the owner can start a test instance');

    const graph = openGraph(withStoredSecrets(graphJson ?? wf.graphJson, wf.graphJson as any));
    const tools = await this.prisma.tool.findMany({ where: { id: { in: graph.nodes.map((n: any) => n.toolId) } } });
    const imageById = new Map(tools.map(t => [t.id, t.dockerImageUrl]));
    const runnable = { ...graph, nodes: graph.nodes.map((n: any) => ({ ...n, dockerImageUrl: imageById.get(n.toolId) })) };

    const instance = await this.prisma.privateWorkflowInstance.create({
      data: { ownerUserId: userId, workflowId, graphJson: sealGraph(graph) },
    });

    const runnerUrl = process.env.WORKFLOW_RUNNER_URL || 'http://localhost:3111/run-workflow';
    try {
      const resp = await lastValueFrom(
        this.httpService.post(runnerUrl, { instanceId: instance.id, graphJson: runnable }, { headers: runnerHeaders(), timeout: 300_000 }),
      );
      if (resp?.data?.usageUrl) {
        const updated = await this.prisma.privateWorkflowInstance.update({
          where: { id: instance.id },
          data: { usageUrl: resp.data.usageUrl },
        });
        return this.present(updated);
      }
      return this.present(instance);
    } catch (e) {
      throw new InternalServerErrorException('Failed to contact workflow runner');
    }
  }

  async runInstance(userId: string, instanceId: string, inputBody: Record<string, any>) {
    const instance = await this.prisma.privateWorkflowInstance.findUnique({ where: { id: instanceId } });
    if (!instance) throw new NotFoundException('Instance not found');
    if (instance.ownerUserId !== userId) throw new ForbiddenException('Not your instance');
    if (!instance.usageUrl) throw new InternalServerErrorException('Instance not ready yet');

    const body = inputBody && 'input' in inputBody ? inputBody : { input: inputBody ?? {} };
    try {
      const resp = await lastValueFrom(this.httpService.post(instance.usageUrl, body, { headers: runnerHeaders(), timeout: 120_000 }));
      return resp.data;
    } catch (err: any) {
      if (err?.response?.status === 404) throw new NotFoundException('Test instance expired, start a new one');
      throw new InternalServerErrorException('Failed to run the workflow');
    }
  }

  async getUserInstances(userId: string) {
    const items = await this.prisma.privateWorkflowInstance.findMany({
      where: { ownerUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map(i => this.present(i));
  }

  async getInstance(id: string, userId: string) {
    const inst = await this.prisma.privateWorkflowInstance.findUnique({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');
    if (inst.ownerUserId !== userId) throw new ForbiddenException('Not your instance');
    return this.present(inst);
  }

  async deleteInstance(id: string, userId: string) {
    const inst = await this.prisma.privateWorkflowInstance.findUnique({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');
    if (inst.ownerUserId !== userId) throw new ForbiddenException('Not your instance');
    await this.prisma.privateWorkflowInstance.delete({ where: { id } });
    return { success: true };
  }
}
