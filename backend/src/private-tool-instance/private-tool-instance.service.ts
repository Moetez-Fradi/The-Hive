import { Injectable, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import { runnerHeaders } from '../common/runner';
import * as crypto from 'crypto';

@Injectable()
export class PrivateToolInstanceService {
  constructor(private prisma: PrismaService, private httpService: HttpService) {}

  private encryptEnv(jsonEnv: Record<string, string>): string {
    const key = Buffer.from(process.env.SERVER_SECRET_KEY!, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const json = JSON.stringify(jsonEnv);
    const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  async createInstance(userId: string, toolId: string, rawEnv: Record<string, string>) {
    const tool = await this.prisma.tool.findUnique({ where: { id: toolId } });
    if (!tool) throw new NotFoundException('Tool not found');

    const envCipher = this.encryptEnv(rawEnv);

    console.log("we got the cipher mate: ", envCipher);

    const instance = await this.prisma.privateToolInstance.create({
      data: { userId, toolId, envCipher },
    });

    const runnerUrl = process.env.TOOL_RUNNER_URL || 'http://localhost:3111/run';
    try {
      const resp = await lastValueFrom(
        this.httpService.post(runnerUrl, {
          instanceId: instance.id,
          dockerImageUrl: tool.dockerImageUrl,
          envCipher: instance.envCipher,
        }, { headers: runnerHeaders(), timeout: 300_000 }),
      );

      if (resp?.data?.usageUrl) {
        const updated = await this.prisma.privateToolInstance.update({
          where: { id: instance.id },
          data: { usageUrl: resp.data.usageUrl },
        });
        return updated;
      }
      return instance;
    } catch {
      throw new InternalServerErrorException('Failed to contact container runner');
    }
  }

  async runInstance( instanceId: string, inputBody: Record<string, any>) {
    const instance = await this.getInstance(instanceId);
    console.log("Running instance: ", instanceId, " at url: ", instance.usageUrl);
    if (!instance.usageUrl) {
      throw new InternalServerErrorException('Instance not ready yet');
    }

    try {
      const targetUrl = `${instance.usageUrl.replace(/\/$/, '')}/run`;
      console.log(targetUrl);
      const resp = await lastValueFrom(this.httpService.post(targetUrl, inputBody));
      return resp.data;
    } catch (err: any) {
      console.error(err);
      throw new InternalServerErrorException('Failed to run the tool');
    }
  }

  async getUserInstances(userId: string) {
    return this.prisma.privateToolInstance.findMany({ where: { userId } });
  }

  async getInstance(id: string) {
    const inst = await this.prisma.privateToolInstance.findUnique({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');
    return inst;
  }

  async deleteInstance(id: string, userId: string) {
    const inst = await this.prisma.privateToolInstance.findUnique({ where: { id } });
    if (!inst) throw new NotFoundException('Instance not found');
    if (inst.userId !== userId) throw new ForbiddenException('Not your instance');
    await this.prisma.privateToolInstance.delete({ where: { id } });
    return { success: true };
  }
}