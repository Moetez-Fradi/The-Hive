'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useUserStore } from '../store/useUserStore';
import { useWalletStore } from '../store/useWalletSore';

interface RouteGuardProps {
  children: React.ReactNode;
  requireLogin?: boolean;
  requireWallet?: boolean;
}

export default function RouteGuard({
  children,
  requireLogin = false,
  requireWallet = false,
}: RouteGuardProps) {
  const router = useRouter();
  const pathname = usePathname();

  const { token } = useUserStore();
  const { accountId } = useWalletStore();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (useUserStore.persist.hasHydrated()) setHydrated(true);
    return useUserStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (requireLogin && !token) {
      router.push(`/login?redirect=${pathname}`);
    }
    // redirect to wallet connect page if wallet not connected
    else if (requireWallet && !accountId) {
      router.push(`/wallet?redirect=${pathname}`);
    }
  }, [hydrated, requireLogin, requireWallet, token, accountId, router, pathname]);

  if (!hydrated) return null;
  if (requireLogin && !token) return null;
  if (requireWallet && !accountId) return null;

  return <>{children}</>;
}
