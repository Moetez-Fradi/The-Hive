"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { connectWallet, getHashConnect, getConnectedAccount, onAccountsChanged, disconnectWallet } from "../../helpers/hashconnect";
import { useUserStore } from "../../store/useUserStore";
import { useWalletStore } from "../../store/useWalletSore";

const API_BASE = (process.env.NEXT_PUBLIC_BACKEND_URL?.replace(/\/$/, '') || 'http://localhost:3001') as string;

export default function WalletPage() {
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletAccountId, setWalletAccountId] = useState<string>("");
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const token = useUserStore(s => s.token);
  const setAccountId = useWalletStore(s => s.setAccountId);
  const isConnected = Boolean(walletAccountId);

  useEffect(() => {
    getHashConnect()
      .then(() => setWalletAccountId(getConnectedAccount() ?? ""))
      .catch(err => setError(err?.message ?? String(err)));
    return onAccountsChanged(ids => setWalletAccountId(ids[0] ?? ""));
  }, []);

  const saveWalletToDatabase = async (accountId: string) => {
    if (!token) {
      setError("Please log in before linking a wallet");
      return;
    }
    const response = await fetch(`${API_BASE}/users/link-wallet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ walletAccountId: accountId }),
    });
    if (!response.ok) throw new Error(`Failed to link wallet (${response.status})`);
    setAccountId(accountId);
    setLinked(true);
  };

  const handleConnect = async () => {
    setError(null);
    setIsConnecting(true);
    try {
      const accountId = await connectWallet();
      setWalletAccountId(accountId);
      await saveWalletToDatabase(accountId);
      router.push('/tools');
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await disconnectWallet();
    setAccountId(null);
    setLinked(false);
  };

  return (
    <>
    <div className="min-h-screen bg-[#0a0b14] relative overflow-hidden flex flex-col">
        
      {/* Decorative wave */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-24 h-56 md:h-64 bg-gradient-to-r from-cyan-500/20 via-blue-500/20 to-purple-500/20 blur-3xl"
      />

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center relative z-10 px-4 pb-20">
        <div className="w-full max-w-2xl">
          {/* Logo and Title */}
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-6">
              <svg width="32" height="32" viewBox="0 0 32 32" className="text-cyan-400" fill="none">
                <path d="M16 2L2 9L16 16L30 9L16 2Z" fill="currentColor" opacity="0.8"/>
                <path d="M2 23L16 30L30 23" stroke="currentColor" strokeWidth="2.5"/>
                <path d="M2 16L16 23L30 16" stroke="currentColor" strokeWidth="2.5"/>
              </svg>
              <span className="text-white text-3xl font-bold">AgentHive</span>
            </div>

            <h1 className="text-4xl font-bold text-white mb-3">
              Connect Your Wallet
            </h1>
            <p className="text-cyan-400 text-base">
              click on connect to continue
            </p>
          </div>

          {/* Wallet Card */}
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm p-6 shadow-xl shadow-cyan-500/5">
            {/* Connection Status */}
            {isConnected && (
              <div className="mb-4 p-4 bg-green-500/10 border border-green-500/30 rounded-lg">
                <p className="text-green-300 font-semibold mb-1">{linked ? 'Wallet linked to your account' : 'Wallet connected'}</p>
                <p className="text-green-200 text-sm">Account: {walletAccountId}</p>
              </div>
            )}
            {error && (
              <div className="mb-4 p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">{error}</div>
            )}

            <div className="space-y-4">
              <div className="border border-cyan-500/40 rounded-xl p-6 text-center bg-cyan-500/10 cursor-pointer hover:bg-cyan-500/20 transition-all">
                <div className="font-semibold text-lg text-white mb-4">Hedera Wallet</div>
                <button 
                  onClick={handleConnect}
                  disabled={isConnecting}
                  className="w-full rounded-md bg-gradient-to-r from-cyan-500 to-blue-500 px-6 py-3 text-white font-semibold hover:from-cyan-400 hover:to-blue-400 transition-all shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/40 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isConnecting ? "Waiting for HashPack..." : isConnected ? "Link this account" : "Connect HashPack"}
                </button>
                {isConnected && (
                  <button onClick={handleDisconnect} className="mt-3 text-sm text-gray-400 hover:text-white underline underline-offset-4">
                    Disconnect
                  </button>
                )}
              </div>
            </div>

            {/* Connection Instructions */}
            <div className="mt-6 p-4 bg-blue-500/10 border border-blue-500/30 rounded-lg">
              <h3 className="text-white font-semibold mb-2">How to connect:</h3>
              <ol className="text-cyan-300 text-sm list-decimal list-inside space-y-1">
                <li>Install HashPack and switch it to Testnet</li>
                <li>Click Connect HashPack above</li>
                <li>Pick HashPack in the WalletConnect window, or scan the QR code</li>
                <li>Approve the connection in HashPack</li>
              </ol>
            </div>

            <div className="text-center mt-6">
              <p className="text-sm text-cyan-400">
                Don't have a wallet?{' '}
                <a href="https://www.hashpack.app/download" target="_blank" rel="noreferrer" className="font-semibold text-white hover:text-cyan-300 underline underline-offset-4">
                  Learn more!
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10 text-center pb-6 px-4">
        <p className="text-xs text-gray-500 leading-relaxed max-w-4xl mx-auto">
          AgentHive · Payments settle on Hedera Testnet
        </p>
      </div>
    </div>
    </>
  );
}