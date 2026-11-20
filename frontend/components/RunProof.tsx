'use client';

import { useState } from 'react';
import axios from 'axios';

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:3001') as string;

export type Proof = {
  inputHash: string;
  outputHash: string;
  runHash: string;
  topicId?: string;
  sequenceNumber?: number;
  transactionId?: string;
  topicUrl?: string;
  messageUrl?: string;
  transactionUrl?: string | null;
};

type Verification = {
  verified: boolean;
  reason: string;
  checks?: Record<string, boolean>;
  consensusTimestamp?: string;
};

function short(hash: string) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function consensusDate(ts?: string) {
  if (!ts) return null;
  const secs = Number(ts.split('.')[0]);
  return Number.isFinite(secs) ? new Date(secs * 1000).toLocaleString() : ts;
}

export default function RunProof({ runId, proof }: { runId: string; proof: Proof | null }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setChecking(true);
    setError(null);
    try {
      const res = await axios.get<Verification>(`${API_BASE}/runs/${runId}/verify`);
      setResult(res.data);
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Verification failed');
    } finally {
      setChecking(false);
    }
  }

  if (!proof) return null;
  const anchored = Boolean(proof.topicId);

  return (
    <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-cyan-300">Proof of execution</div>
          <div className="text-xs text-gray-400">
            {anchored
              ? `Anchored on Hedera Consensus Service, topic ${proof.topicId} #${proof.sequenceNumber}`
              : 'Hashes computed, not anchored on Hedera'}
          </div>
        </div>
        {anchored && (
          <button
            onClick={verify}
            disabled={checking}
            className="px-3 py-1.5 rounded bg-cyan-400 text-black text-sm font-semibold disabled:opacity-50"
          >
            {checking ? 'Checking mirror node…' : 'Verify on Hedera'}
          </button>
        )}
      </div>

      <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs font-mono">
        <dt className="text-gray-400">input hash</dt>
        <dd title={proof.inputHash}>{short(proof.inputHash)}</dd>
        <dt className="text-gray-400">output hash</dt>
        <dd title={proof.outputHash}>{short(proof.outputHash)}</dd>
        <dt className="text-gray-400">run hash</dt>
        <dd title={proof.runHash}>{short(proof.runHash)}</dd>
      </dl>

      {anchored && (
        <div className="flex flex-wrap gap-4 text-xs">
          {proof.messageUrl && (
            <a href={proof.messageUrl} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
              HCS message on HashScan
            </a>
          )}
          {proof.transactionUrl && (
            <a href={proof.transactionUrl} target="_blank" rel="noreferrer" className="text-cyan-300 underline">
              Submit transaction
            </a>
          )}
        </div>
      )}

      {result && (
        <div className={`text-sm ${result.verified ? 'text-green-300' : 'text-red-300'}`}>
          {result.verified ? 'Verified. ' : 'Mismatch. '}
          {result.reason}
          {result.consensusTimestamp && <span className="text-gray-400"> (consensus {consensusDate(result.consensusTimestamp)})</span>}
        </div>
      )}
      {error && <div className="text-sm text-red-300">{error}</div>}
    </div>
  );
}
