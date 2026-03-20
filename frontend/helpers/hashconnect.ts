// use hashconnect instead of cryptowallet
import { HashConnect } from "hashconnect";
import { TransferTransaction, Hbar } from "@hashgraph/sdk";

const STORAGE_KEY = "agenthive_hashconnect_v1";
const NETWORK = "testnet";

function loadSaved() {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
}
function saveSaved(obj: any) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

export async function connectToWallet() {
  const hc = new HashConnect();
  const appMetadata = {
    name: "AgentHive PoC",
    description: "Agenthive test",
    icon: "https://cdn-icons-png.flaticon.com/512/4712/4712109.png",
  };

  const saved = loadSaved();
  let initData: any;
  if (saved?.privKey) {
    try { initData = await hc.init(appMetadata, saved.privKey); } catch { initData = await hc.init(appMetadata); }
  } else {
    initData = await hc.init(appMetadata);
  }

  if (initData?.privKey) saveSaved({ ...saved, privKey: initData.privKey, topic: initData.topic ?? saved?.topic ?? null });

  const pairedPromise = new Promise<any>((resolve) => {
    hc.pairingEvent.on((pd: any) => {
      const s = loadSaved() || {};
      if (pd.topic) { s.topic = pd.topic; saveSaved(s); }
      if (pd.accountIds?.length) {
        s.accountIds = pd.accountIds;
        saveSaved(s);
        resolve(pd);
      }
    });
  });

  const state = await hc.connect();
  hc.findLocalWallets();
  const pairingString = hc.generatePairingString(state, NETWORK, false);

  if (saved?.accountIds?.length) {
    return { hc, pairingString, pairingData: { accountIds: saved.accountIds, topic: saved.topic }, pairedPromise };
  }

  return { hc, pairingString, pairedPromise, pairingData: null };
}

export async function doPay(options: {
  hc: any;
  pairingData: any | null;
  payment: { receipt: Array<{ receiver?: string; amount?: number }>; total?: number; memo?: string };
  waitForPair?: boolean;
}) {
  const { hc, payment } = options;
  let pairingData = options.pairingData;
  if (!hc) throw new Error("HashConnect instance required");

  if (!pairingData && options.waitForPair) {
    const saved = loadSaved();
    if (saved?.accountIds?.length) pairingData = { accountIds: saved.accountIds, topic: saved.topic };
    else {
      const pd = await (options as any).pairedPromise;
      pairingData = pd;
    }
  }

  if (!pairingData?.accountIds?.length) throw new Error("Wallet not paired or no account ID available");
  if (!pairingData.topic) throw new Error("Pairing topic missing");

  const fromId = pairingData.accountIds[0];
  const total = payment.total ?? payment.receipt.reduce((s, it) => s + Number(it.amount || 0), 0);
  if (total <= 0) throw new Error("Nothing to pay");

  const byReceiver: Record<string, number> = {};
  for (const it of payment.receipt) {
    if (!it.receiver) continue;
    byReceiver[it.receiver] = (byReceiver[it.receiver] || 0) + Number(it.amount || 0);
  }

  const tx = new TransferTransaction().setTransactionMemo(payment.memo || "");
  tx.addHbarTransfer(fromId, new Hbar(-total));
  for (const r of Object.keys(byReceiver)) {
    tx.addHbarTransfer(r, new Hbar(byReceiver[r]));
  }

  const provider = hc.getProvider(NETWORK, pairingData.topic, fromId);
  const signer = hc.getSigner(provider);
  if (!signer) throw new Error("Signer not available from HashConnect");

  await (tx as any).freezeWithSigner(signer);
  const txResponse = await (tx as any).executeWithSigner(signer);
  const txId = txResponse?.transactionId?.toString?.() ?? String(txResponse);

  return { txId, txResponse };
}
