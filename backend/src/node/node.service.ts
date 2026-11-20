import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterNodeDto } from './dto/node.dto';
import { NodeStatus } from '@prisma/client';

@Injectable()
export class NodeService {
  constructor(private prisma: PrismaService) {}

  async registerNode(userId: string, dto: RegisterNodeDto) {
    const { publicKey, capabilities, minPricePerSec, url } = dto;

    let user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user?.walletAccountId) {
      throw new Error('You have no wallet linked to your account. Please link a wallet first.');
    }

    let node = await this.prisma.node.findFirst({
      where: { ownerUserId: userId, publicKey },
    });

    if (!node) {
      node = await this.prisma.node.create({
        data: {
          ownerUserId: userId,
          publicKey,
          capabilities,
          minPricePerSec: minPricePerSec || 0,
          url: url || "EMPTY",
          status: 'ONLINE',
          lastSeenAt: new Date(),
        },
      });
    } else {
      node = await this.prisma.node.update({
        where: { id: node.id },
        data: {
          url,
          status: 'ONLINE',
          lastSeenAt: new Date(),
          capabilities,
          minPricePerSec: minPricePerSec || node.minPricePerSec,
        },
      });
    }

    return node;
  }

  async updateStatus(userId: string, nodeId: string, status: NodeStatus) {
    if (!nodeId) throw new BadRequestException('nodeId required');
    const node = await this.prisma.node.findFirst({
      where: { id: nodeId, ownerUserId: userId },
    });
    if (!node) throw new NotFoundException('Node not found');

    return this.prisma.node.update({
      where: { id: node.id },
      data: { status, lastSeenAt: new Date() },
    });
}

  async redeemToken(userId: string, nodeId: string, jti: string) {
    if (!nodeId || !jti) throw new BadRequestException('nodeId and token required');
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, ownerUserId: userId } });
    if (!node) throw new NotFoundException('Node not found');
    const claimed = await this.prisma.oneTimeToken.updateMany({
      where: { jti, nodeId, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('Token is invalid, expired or already used');
    return { valid: true };
  }

  async getAllNodes() {
    return this.prisma.node.findMany();
  }
}
