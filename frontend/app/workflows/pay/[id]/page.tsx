'use client';

import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import axios from 'axios';
import { useUserStore } from '../../../../store/useUserStore';
import { connectWallet, getConnectedAccount, getHashConnect, onAccountsChanged, payReceipt } from '../../../../helpers/hashconnect';

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:3001') as string;

type Payout = { receiver: string; amount: number; toolName?: string };
type Payment = { id: string; instanceId: string; payer: string; receipt: Payout[]; total: number; memo?: string; paid: boolean; txHash?: string };
type Confirmation = {
  verified: boolean;
  reason: string;
  workflowId: string | null;
  txHash: string;
  consensusTimestamp: string | null;
  audit?: { topicId: string; sequenceNumber: number } | null;
};

function hashscanTxUrl(txId: string) {
  const [account, ts] = txId.split('@');
  const mirrorId = ts ? `${account}-${ts.replace('.', '-')}` : txId;
  return `https://hashscan.io/testnet/transaction/${mirrorId}`;
}

export default function PayPage() {
  const params = useParams();
  const paymentId = params?.id as string | undefined;
  const router = useRouter();
  const token = useUserStore(s => s.token);

  const [payment, setPayment] = useState<Payment | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);

  useEffect(() => {
    if (!paymentId) return;
    setLoading(true);
    axios
      .get<Payment>(`${API_BASE}/payments/${paymentId}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(res => setPayment(res.data))
      .catch(() => setError('Failed to load payment receipt'))
      .finally(() => setLoading(false));
  }, [paymentId, token]);

  useEffect(() => {
    getHashConnect()
      .then(() => setAccount(getConnectedAccount()))
      .catch(err => setError(err?.message ?? String(err)));
    return onAccountsChanged(ids => setAccount(ids[0] ?? null));
  }, []);

  const computeTotal = (p: Payout[]) => Number(p.reduce((sum, x) => sum + Number(x.amount || 0), 0).toFixed(8));

  async function doPay() {
    if (!payment) return;
    setPaying(true);
    setError(null);
    try {
      const from = account ?? (await connectWallet());
      if (payment.payer && from !== payment.payer) {
        throw new Error(`Connected wallet ${from} does not match the linked wallet ${payment.payer}`);
      }
      const { txId } = await payReceipt(payment.receipt, payment.memo);
      const res = await axios.post<Confirmation>(
        `${API_BASE}/payments/confirm`,
        { instanceId: payment.instanceId, txId },
        { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      );
      setConfirmation(res.data);
      setPayment({ ...payment, paid: res.data.verified, txHash: txId });
      if (!res.data.verified) setError(`Payment sent but not verified: ${res.data.reason}`);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? String(err));
    } finally {
      setPaying(false);
    }
  }

  if (!paymentId) return <div className="p-6">Missing payment id</div>;
  if (loading) return <div className="p-6">Loading payment details…</div>;

  return (
    <div className="p-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-4">Confirm Payment</h1>
      {error && <div className="mb-4 text-red-400">{error}</div>}
      {!payment && <div className="text-gray-400">No payment receipt found.</div>}

      {payment && (
        <>
          <div className="mb-4 bg-[#071424] border border-white/6 rounded p-4">
            <div className="text-sm text-gray-300">Instance</div>
            <div className="font-mono">{payment.instanceId}</div>
            <div className="text-sm text-gray-300 mt-2">Memo</div>
            <div className="font-mono">{payment.memo ?? '-'}</div>
            <div className="text-sm text-gray-300 mt-2">Paying from</div>
            <div className="font-mono">{account ?? 'wallet not connected'}</div>
          </div>

          <div className="bg-[#071424] border border-white/6 rounded p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-gray-300">Recipients</div>
              <div className="text-sm text-gray-300">Total: <span className="font-mono">{computeTotal(payment.receipt)} HBAR</span></div>
            </div>

            {payment.receipt.length === 0 && <div className="text-sm text-gray-400">All tools in this workflow are free.</div>}
            <ul className="space-y-2">
              {payment.receipt.map((p, i) => (
                <li key={i} className="flex items-center justify-between p-2 bg-[#0b1620] rounded">
                  <div>
                    <div className="font-semibold">{p.toolName ?? p.receiver}</div>
                    <div className="text-xs text-gray-400">{p.receiver}</div>
                  </div>
                  <div className="font-mono">{p.amount} HBAR</div>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex gap-2">
              {payment.paid ? (
                <button onClick={() => router.push(`/workflows/${confirmation?.workflowId ?? ''}`)} className="px-4 py-2 bg-green-500 text-black rounded">
                  Paid, open workflow
                </button>
              ) : (
                <button onClick={doPay} disabled={paying || payment.receipt.length === 0} className="px-4 py-2 bg-yellow-400 text-black rounded disabled:opacity-50">
                  {paying ? 'Waiting for HashPack…' : account ? `Pay ${computeTotal(payment.receipt)} HBAR` : 'Connect HashPack and pay'}
                </button>
              )}
              <button onClick={() => router.push('/workflows')} className="px-4 py-2 border rounded">
                Back
              </button>
            </div>
          </div>
        </>
      )}

      {payment?.txHash && (
        <div className="mt-6 bg-[#071424] border border-white/6 rounded p-4">
          <div className="text-sm text-gray-300">Transaction</div>
          <a href={hashscanTxUrl(payment.txHash)} target="_blank" rel="noreferrer" className="font-mono text-cyan-300 underline break-all">
            {payment.txHash}
          </a>
          {confirmation && (
            <div className="text-sm mt-2 text-gray-300">
              {confirmation.verified ? 'Verified on the Hedera mirror node' : `Not verified: ${confirmation.reason}`}
            </div>
          )}
          {confirmation?.audit && (
            <a
              href={`https://hashscan.io/testnet/topic/${confirmation.audit.topicId}/message/${confirmation.audit.sequenceNumber}`}
              target="_blank"
              rel="noreferrer"
              className="block text-sm mt-2 text-cyan-300 underline"
            >
              Payment receipt anchored on HCS topic {confirmation.audit.topicId} #{confirmation.audit.sequenceNumber}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
