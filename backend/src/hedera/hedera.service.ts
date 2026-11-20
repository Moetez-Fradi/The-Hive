import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import {
  Client,
  Hbar,
  TransferTransaction,
  AccountId,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransactionId,
  Timestamp,
} from '@hashgraph/sdk';
import { PrismaService } from '../prisma/prisma.service';

const MIRROR_NODE_URL = process.env.HEDERA_MIRROR_URL || 'https://testnet.mirrornode.hedera.com';

export type AuditReceipt = {
  topicId: string;
  sequenceNumber: number;
  transactionId: string;
};

export type MirrorTopicMessage = {
  topicId: string;
  sequenceNumber: number;
  consensusTimestamp: string;
  message: string;
};

export type MirrorTransaction = {
  transactionId: string;
  result: string;
  payer: string;
  memo: string;
  consensusTimestamp: string;
  transfers: Record<string, number>;
};

@Injectable()
export class HederaService {
  private client: Client | null = null;
  private topicId: Promise<string> | null = null;
  private clockOffsetMs = 0;
  private clockCheckedAt = 0;
  private readonly logger = new Logger(HederaService.name);

  constructor(private readonly prisma: PrismaService) {}

  private getClient(): Client {
    if (this.client) return this.client;
    const operatorId = process.env.OPERATOR_ID;
    const operatorKey = process.env.OPERATOR_KEY;
    if (!operatorId || !operatorKey) {
      throw new InternalServerErrorException('OPERATOR_ID and OPERATOR_KEY must be set to use the Hedera operator');
    }
    const client = Client.forTestnet();
    client.setOperator(AccountId.fromString(operatorId), HederaService.parseKey(operatorKey));
    this.client = client;
    return client;
  }

  private async networkTxId(): Promise<TransactionId> {
    if (Date.now() - this.clockCheckedAt > 10 * 60 * 1000) {
      try {
        const res = await fetch(`${MIRROR_NODE_URL}/api/v1/network/nodes?limit=1`, { method: 'HEAD' });
        const networkNow = Date.parse(res.headers.get('date') ?? '');
        if (!Number.isNaN(networkNow)) {
          this.clockOffsetMs = Math.abs(networkNow - Date.now()) > 5000 ? networkNow - Date.now() : 0;
          if (this.clockOffsetMs) this.logger.warn(`Local clock is off by ${Math.round(this.clockOffsetMs / 1000)}s, compensating`);
        }
        this.clockCheckedAt = Date.now();
      } catch {}
    }
    const validStart = new Date(Date.now() + this.clockOffsetMs - 5000);
    return TransactionId.withValidStart(AccountId.fromString(process.env.OPERATOR_ID!), Timestamp.fromDate(validStart));
  }

  static parseKey(raw: string): PrivateKey {
    const key = raw.trim().replace(/^0x/, '');
    if (key.startsWith('302e') || key.startsWith('3030')) return PrivateKey.fromStringDer(key);
    if (process.env.OPERATOR_KEY_TYPE?.toUpperCase() === 'ED25519') return PrivateKey.fromStringED25519(key);
    return PrivateKey.fromStringECDSA(key);
  }

  static toMirrorTxId(txId: string): string {
    const [account, ts] = txId.split('@');
    if (!ts) return txId;
    const [secs, nanos = '0'] = ts.split('.');
    return `${account}-${secs}-${nanos}`;
  }

  async getMirrorTransaction(txId: string, attempts = 10, delayMs = 1500): Promise<MirrorTransaction | null> {
    const url = `${MIRROR_NODE_URL}/api/v1/transactions/${HederaService.toMirrorTxId(txId)}`;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const body: any = await res.json();
          const tx = body?.transactions?.[0];
          if (tx) {
            const transfers: Record<string, number> = {};
            for (const t of tx.transfers ?? []) {
              transfers[t.account] = (transfers[t.account] || 0) + Number(t.amount) / 100_000_000;
            }
            return {
              transactionId: tx.transaction_id,
              result: tx.result,
              payer: String(tx.transaction_id).split('-')[0],
              memo: tx.memo_base64 ? Buffer.from(tx.memo_base64, 'base64').toString('utf8') : '',
              consensusTimestamp: tx.consensus_timestamp,
              transfers,
            };
          }
        }
      } catch (err: any) {
        this.logger.warn(`Mirror node lookup failed: ${err?.message || err}`);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }

  async transferHbar(fromAccountId: string, toAccountId: string, amountHbar: number, memo?: string) {
    const client = this.getClient();
    const tx = new TransferTransaction()
      .setTransactionId(await this.networkTxId())
      .addHbarTransfer(fromAccountId, new Hbar(-amountHbar))
      .addHbarTransfer(toAccountId, new Hbar(amountHbar));
    if (memo) tx.setTransactionMemo(memo);

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    return { txId: response.transactionId.toString(), status: receipt.status.toString() };
  }

  isConfigured() {
    return Boolean(process.env.OPERATOR_ID && process.env.OPERATOR_KEY);
  }

  async getAuditTopicId(): Promise<string> {
    if (process.env.HCS_TOPIC_ID) return process.env.HCS_TOPIC_ID;
    if (!this.topicId) {
      this.topicId = this.loadOrCreateTopic().catch(err => {
        this.topicId = null;
        throw err;
      });
    }
    return this.topicId;
  }

  private async loadOrCreateTopic(): Promise<string> {
    const saved = await this.prisma.setting.findUnique({ where: { key: 'hcs_topic_id' } });
    if (saved) return saved.value;

    const client = this.getClient();
    const operatorKey = HederaService.parseKey(process.env.OPERATOR_KEY!);
    const tx = await new TopicCreateTransaction()
      .setTransactionId(await this.networkTxId())
      .setTopicMemo('AgentHive execution and payment audit log')
      .setSubmitKey(operatorKey.publicKey)
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId!.toString();
    await this.prisma.setting.upsert({
      where: { key: 'hcs_topic_id' },
      update: { value: topicId },
      create: { key: 'hcs_topic_id', value: topicId },
    });
    this.logger.log(`Created HCS audit topic ${topicId}`);
    return topicId;
  }

  async submitAudit(message: Record<string, any>): Promise<AuditReceipt> {
    const client = this.getClient();
    const topicId = await this.getAuditTopicId();
    const response = await new TopicMessageSubmitTransaction()
      .setTransactionId(await this.networkTxId())
      .setTopicId(topicId)
      .setMessage(JSON.stringify(message))
      .execute(client);
    const receipt = await response.getReceipt(client);
    return {
      topicId,
      sequenceNumber: Number(receipt.topicSequenceNumber),
      transactionId: response.transactionId.toString(),
    };
  }

  async getTopicMessage(topicId: string, sequenceNumber: number, attempts = 10, delayMs = 1500): Promise<MirrorTopicMessage | null> {
    const url = `${MIRROR_NODE_URL}/api/v1/topics/${topicId}/messages/${sequenceNumber}`;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const body: any = await res.json();
          return {
            topicId: body.topic_id,
            sequenceNumber: body.sequence_number,
            consensusTimestamp: body.consensus_timestamp,
            message: Buffer.from(body.message, 'base64').toString('utf8'),
          };
        }
      } catch (err: any) {
        this.logger.warn(`Mirror topic lookup failed: ${err?.message || err}`);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    return null;
  }
}
