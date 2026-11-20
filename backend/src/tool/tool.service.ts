import { Injectable, BadRequestException, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateToolDto } from './dto/tool.dto';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { runnerHeaders } from '../common/runner';
import { PrivateToolInstanceService } from '../private-tool-instance/private-tool-instance.service';
import * as crypto from 'crypto';

@Injectable()
export class ToolService {
  constructor(
    private prisma: PrismaService,
    private httpService: HttpService,
    private ptiService: PrivateToolInstanceService,
) {}

  private encryptEnv(jsonEnv: Record<string, string>): string {
    const key = Buffer.from(process.env.SERVER_SECRET_KEY!, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const json = JSON.stringify(jsonEnv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  async createTool(userId: string, ownerWallet: string | undefined, dto: CreateToolDto) {
    if (!ownerWallet) throw new BadRequestException('Connected user has no wallet configured.');
    const data = {
      name: dto.name,
      description: dto.description ?? null,
      dockerImageUrl: dto.dockerImageUrl,
      ownerWallet,
      usagePrice: dto.usagePrice ?? 0,
      requiredEnv: dto.requiredEnv ?? [],
      inputShape: dto.inputShape ?? 'Not specified',
      outputShape: dto.outputShape ?? 'Not specified',
    };
    const tool = await this.prisma.tool.create({ data });
    return tool;
  }

  async findById(id: string) {
    const t = await this.prisma.tool.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Tool not found');
    return t;
  }

  async deleteTool(id: string, requestingWallet: string) {
    const tool = await this.prisma.tool.findUnique({ where: { id } });
    if (!tool) throw new NotFoundException('Tool not found');
    if (tool.ownerWallet !== requestingWallet) throw new ForbiddenException('Only owner can delete tool');
    await this.prisma.tool.delete({ where: { id } });
    return { success: true };
  }

  async testTool(userId: string, requestingWallet: string, toolId: string, env: Record<string, string>) {
    const tool = await this.prisma.tool.findUnique({ where: { id: toolId } });
    if (!tool) throw new NotFoundException('Tool not found');
    if (tool.ownerWallet !== requestingWallet) throw new ForbiddenException('Only owner can test tool');

    const instance = await this.ptiService.createInstance(userId, toolId, env);

    if (!instance.usageUrl) {
      return { success: true, deployed: false, pending: true, instance };
    }

    return { success: false, deployed: false, tool: tool, instance };
  }

  async runDeployTests(
  userId: string,
  requestingWallet: string,
  toolId: string,
  env: Record<string, string>,
  tests: Array<any>,
) {
  const tool = await this.prisma.tool.findUnique({ where: { id: toolId } });
  if (!tool) throw new NotFoundException('Tool not found');
  if (tool.ownerWallet !== requestingWallet) throw new ForbiddenException('Only owner can deploy');
  if (!env || typeof env !== 'object') throw new BadRequestException('env required');

  const envCipher = this.encryptEnv(env);
  console.log("getting into runner...");

  const runnerUrl = process.env.TOOL_DEPLOYER_URL || 'http://localhost:3111/run-and-test';
  let resp;
  try {
    resp = await lastValueFrom(
      this.httpService.post(runnerUrl, {
        instanceId: `${toolId}-deploytest-${Date.now().toString(36)}`,
        dockerImageUrl: tool.dockerImageUrl,
        envCipher,
        tests,
        inputShape: tool.inputShape ?? {},
        outputShape: tool.outputShape ?? {},
      }, { headers: runnerHeaders(), timeout: 300_000 }),
    );
  } catch (e) {
    throw new InternalServerErrorException('Failed to contact test runner');
  }

  console.log("we got our response!");

  const data = resp?.data;
  if (!data) throw new InternalServerErrorException('Empty response from runner');

  if (!data.passed) {
    return { success: false, reason: 'tests_failed', details: data };
  }

  const pricing = data.pricing ?? {};
  const energyBaseline =
    typeof data.energyBaseline === 'number' ? data.energyBaseline : null;

  const updated = await this.prisma.tool.update({
    where: { id: toolId },
    data: {
      status: 'DEPLOYED',
      priceMode: pricing.priceMode ?? 'FIXED',
      fixedPrice: pricing.fixedPrice ?? 0,
      dynamicInputCoeff: pricing.dynamicInputCoeff ?? 0,
      dynamicOutputCoeff: pricing.dynamicOutputCoeff ?? 0,
      energyBaseline,
    },
  });

  return { success: true, tool: updated, testReport: data };
}

  async listTools(page = 1, limit = 10) {
    const tools = await this.prisma.tool.findMany({
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await this.prisma.tool.count();
    return { tools, total, page, limit };
  }

  async searchTools(query: string, limit = 10) {
    if (!query) return [];

    const tools = await this.prisma.tool.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { rating: 'desc' },
    });

    return tools;
  }
}
