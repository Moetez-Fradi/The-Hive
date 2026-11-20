'use client';
import Link from 'next/link';
import { useUserStore } from '../store/useUserStore';

export default function Navbar() {
  const { token, email, userId, clearUser } = useUserStore();
  const isLoggedIn = Boolean(token && userId);

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    clearUser();
  };

  return (
    <nav className="relative z-20 flex items-center justify-between px-8 py-4">
      <Link href="/" className="flex items-center gap-2">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-cyan-400">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor" opacity="0.6" />
          <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" />
          <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className="text-white text-xl font-bold">AgentHive</span>
      </Link>

      <div className="flex items-center gap-6 text-sm">
        <Link href="/docs" className="text-gray-300 hover:text-white transition-colors">
          Docs
        </Link>
        <Link href="/workflows" className="text-gray-300 hover:text-white transition-colors">
          Workflows
        </Link>
        <Link href="/tools" className="text-gray-300 hover:text-white transition-colors">
          Tools
        </Link>

        {!isLoggedIn ? (
          <div className="flex items-center gap-4">
            <Link
              href="/signup"
              className="px-4 py-2 rounded-md bg-white/10 backdrop-blur-sm border border-white/20 text-white hover:bg-white/20 transition-all"
            >
              Register
            </Link>
            <Link
              href="/login"
              className="px-4 py-2 rounded-md bg-cyan-500 text-white hover:bg-cyan-600 transition-all"
            >
              Login
            </Link>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <Link href="/wallet" className="text-gray-300 hover:text-white transition-colors">
              Wallet
            </Link>
            <Link
              href={`/users/${userId}`}
              className="px-4 py-2 rounded-md bg-white/10 backdrop-blur-sm border border-white/20 text-white hover:bg-white/20 transition-all"
            >
              {email?.split('@')[0] || 'Profile'}
            </Link>
            <button
              onClick={handleLogout}
              className="px-4 py-2 rounded-md bg-red-500 text-white hover:bg-red-600 transition-all"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
