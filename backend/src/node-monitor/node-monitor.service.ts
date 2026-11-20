import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NodeStatus } from '@prisma/client';

@Injectable()
export class NodeMonitorService {
  private readonly logger = new Logger(NodeMonitorService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async checkOfflineNodes() {
    const threshold = new Date(Date.now() - 3 * 60 * 1000);
    const result = await this.prisma.node.updateMany({
      where: {
        status: { in: [NodeStatus.ONLINE, NodeStatus.BUSY] },
        OR: [{ lastSeenAt: { lt: threshold } }, { lastSeenAt: null }],
      },
      data: { status: NodeStatus.OFFLINE },
    });

    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} nodes as OFFLINE due to missed heartbeat`);
    }
  }
}
