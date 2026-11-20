import type { HashConnect } from "hashconnect";

const PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

type Listener = (accountIds: string[]) => void;

let instance: HashConnect | null = null;
let initPromise: Promise<HashConnect> | null = null;
let accountIds: string[] = [];
const listeners = new Set<Listener>();

function emit(ids: string[]) {
  accountIds = ids;
  listeners.forEach(l => l(ids));
}

export function onAccountsChanged(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConnectedAccount(): string | null {
  return accountIds[0] ?? null;
}

export async function getHashConnect(): Promise<HashConnect> {
  if (instance) return instance;
  if (initPromise) return initPromise;
  if (typeof window === "undefined") throw new Error("HashConnect is only available in the browser");
  if (!PROJECT_ID) throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set");

  initPromise = (async () => {
    const [{ HashConnect }, { LedgerId }] = await Promise.all([import("hashconnect"), import("@hashgraph/sdk")]);
    const hc = new HashConnect(
      LedgerId.TESTNET,
      PROJECT_ID,
      {
        name: "AgentHive",
        description: "Decentralized AI agent marketplace on Hedera",
        icons: [`${window.location.origin}/favicon.ico`],
        url: window.location.origin,
      },
      false,
    );
    hc.pairingEvent.on(session => emit((session.accountIds ?? []).map(String)));
    hc.disconnectionEvent.on(() => emit([]));
    await hc.init();
    emit(hc.connectedAccountIds.map(a => a.toString()));
    instance = hc;
    return hc;
  })();

  try {
    return await initPromise;
  } catch (err) {
    initPromise = null;
    throw err;
  }
}

export async function connectWallet(timeoutMs = 5 * 60 * 1000): Promise<string> {
  const hc = await getHashConnect();
  if (accountIds.length) return accountIds[0];

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Wallet pairing timed out"));
    }, timeoutMs);
    const off = onAccountsChanged(ids => {
      if (!ids.length) return;
      clearTimeout(timer);
      off();
      resolve(ids[0]);
    });
    hc.openPairingModal();
  });
}

export async function disconnectWallet() {
  if (!instance) return;
  await instance.disconnect();
  emit([]);
}

export type ReceiptItem = { receiver?: string; amount?: number; toolName?: string };

export async function payReceipt(receipt: ReceiptItem[], memo?: string): Promise<{ txId: string; payer: string }> {
  const hc = await getHashConnect();
  const payer = getConnectedAccount() ?? (await connectWallet());
  const { TransferTransaction, Hbar, AccountId } = await import("@hashgraph/sdk");

  const tinybarsByReceiver: Record<string, number> = {};
  for (const it of receipt) {
    if (!it.receiver || it.receiver === payer) continue;
    const tinybars = Math.round(Number(it.amount || 0) * 100_000_000);
    if (tinybars <= 0) continue;
    tinybarsByReceiver[it.receiver] = (tinybarsByReceiver[it.receiver] || 0) + tinybars;
  }
  const receivers = Object.keys(tinybarsByReceiver);
  if (!receivers.length) throw new Error("Nothing to pay");

  const total = receivers.reduce((s, r) => s + tinybarsByReceiver[r], 0);
  const tx = new TransferTransaction().addHbarTransfer(payer, Hbar.fromTinybars(-total));
  for (const r of receivers) tx.addHbarTransfer(r, Hbar.fromTinybars(tinybarsByReceiver[r]));
  if (memo) tx.setTransactionMemo(memo.slice(0, 100));

  const signer = hc.getSigner(AccountId.fromString(payer) as any);
  const frozen = await tx.freezeWithSigner(signer as any);
  const response = await frozen.executeWithSigner(signer as any);
  return { txId: response.transactionId.toString(), payer };
}
