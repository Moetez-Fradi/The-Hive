import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HederaService } from '../hedera/hedera.service';
import { sha256 } from '../common/hash';

type ReceiptItem = { receiver: string; toolName?: string; amount: number };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(private prisma: PrismaService, private hedera: HederaService) {}

  async createPayment(instanceId: string, payer: string, receipt: ReceiptItem[], memo?: string) {
    if (!instanceId) throw new BadRequestException('instanceId required');
    if (!payer) throw new BadRequestException('payer required');
    if (!Array.isArray(receipt)) throw new BadRequestException('receipt must be an array');

    const existing = await this.prisma.payment.findUnique({ where: { instanceId } });
    if (existing) return existing;

    const total = receipt.reduce((s, it) => s + Number(it.amount || 0), 0);
    return this.prisma.payment.create({
      data: { instanceId, payer, receipt: receipt as any, total, memo: memo ?? null },
    });
  }

  async getPaymentById(id: string) {
    const payment = await this.prisma.payment.findFirst({ where: { OR: [{ id }, { instanceId: id }] } });
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async confirmPayment(instanceId: string, txId: string) {
    if (!instanceId || !txId) throw new BadRequestException('instanceId and txId required');

    const payment = await this.prisma.payment.findUnique({ where: { instanceId } });
    if (!payment) throw new NotFoundException('Payment not found');

    const tx = await this.hedera.getMirrorTransaction(txId);
    let verified = false;
    let reason = 'transaction not found on mirror node';

    if (tx) {
      const receipt = (payment.receipt as ReceiptItem[]) || [];
      const expected: Record<string, number> = {};
      for (const it of receipt) {
        if (!it.receiver || it.receiver === tx.payer) continue;
        expected[it.receiver] = (expected[it.receiver] || 0) + Number(it.amount || 0);
      }
      const underpaid = Object.entries(expected).filter(([acc, amt]) => (tx.transfers[acc] ?? 0) + 1e-8 < amt);

      const reused = await this.prisma.payment.findFirst({
        where: { txHash: txId, paid: true, NOT: { instanceId } },
        select: { id: true },
      });

      if (tx.result !== 'SUCCESS') reason = `transaction result ${tx.result}`;
      else if (reused) reason = 'transaction already used for another payment';
      else if (payment.memo && tx.memo !== payment.memo) reason = `memo "${tx.memo}" does not match "${payment.memo}"`;
      else if (payment.payer && tx.payer !== payment.payer) reason = `paid by ${tx.payer}, expected ${payment.payer}`;
      else if (underpaid.length) reason = `underpaid: ${underpaid.map(([a]) => a).join(', ')}`;
      else {
        verified = true;
        reason = 'ok';
      }
    }

    let updated = await this.prisma.payment.update({
      where: { instanceId },
      data: { txHash: txId, paid: verified },
    });

    if (verified && this.hedera.isConfigured() && updated.hcsSequence == null) {
      try {
        const audit = await this.hedera.submitAudit({
          v: 1,
          app: 'AgentHive',
          type: 'deployment-payment',
          paymentId: updated.id,
          instanceId,
          payer: updated.payer,
          total: updated.total,
          paymentTx: txId,
          receiptHash: sha256(updated.receipt),
        });
        updated = await this.prisma.payment.update({
          where: { instanceId },
          data: { hcsTopicId: audit.topicId, hcsSequence: audit.sequenceNumber },
        });
      } catch (err: any) {
        this.logger.error(`HCS anchoring failed for payment ${updated.id}: ${err?.message || err}`);
      }
    }

    const instance = await this.prisma.privateWorkflowInstance.findUnique({
      where: { id: instanceId },
      select: { workflowId: true },
    });

    return {
      success: verified,
      verified,
      reason,
      instanceId: updated.instanceId,
      workflowId: instance?.workflowId ?? null,
      txHash: updated.txHash,
      paid: updated.paid,
      total: updated.total,
      receipt: updated.receipt,
      consensusTimestamp: tx?.consensusTimestamp ?? null,
      audit: updated.hcsTopicId ? { topicId: updated.hcsTopicId, sequenceNumber: updated.hcsSequence } : null,
    };
  }
}
