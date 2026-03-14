"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction } from "@solana/web3.js";
import confetti from "canvas-confetti";
import { playCashSound } from "@/lib/sound";
import {
  checkCashback,
  buildClaimInstructions,
  calculateFee,
  lamportsToSol,
  type CashbackBalances,
  type FeeConfig,
} from "@/lib/cashback";

const FEE_WALLET = process.env.NEXT_PUBLIC_FEE_WALLET;
const FEE_BPS = Number(process.env.NEXT_PUBLIC_FEE_BPS || "0");

function getFeeConfig(): FeeConfig | undefined {
  if (!FEE_WALLET || FEE_BPS <= 0) return undefined;
  try {
    return { wallet: new PublicKey(FEE_WALLET), bps: FEE_BPS };
  } catch {
    return undefined;
  }
}

type Status = "idle" | "checking" | "claiming" | "success" | "error";

export default function CashbackChecker() {
  const [address, setAddress] = useState("");
  const [balances, setBalances] = useState<CashbackBalances | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [txSignature, setTxSignature] = useState("");

  const { publicKey, signTransaction } = useWallet();
  const { connection } = useConnection();

  // Pre-populate input with connected wallet address and clear stale results
  const prevPublicKey = useRef<string | null>(null);
  useEffect(() => {
    const newKey = publicKey?.toBase58() ?? null;
    if (newKey && newKey !== prevPublicKey.current) {
      setAddress(newKey);
      setBalances(null);
      setTxSignature("");
      setError("");
      setStatus("idle");
    }
    prevPublicKey.current = newKey;
  }, [publicKey]);

  const totalLamports = balances
    ? balances.pumpLamports + balances.ammLamports
    : 0;
  const hasCashback = totalLamports > 0;
  const feeConfig = getFeeConfig();
  const totalFee = feeConfig
    ? calculateFee(balances?.pumpLamports ?? 0, feeConfig.bps) +
      calculateFee(balances?.ammLamports ?? 0, feeConfig.bps)
    : 0;
  const netLamports = totalLamports - totalFee;
  const isOwnWallet =
    publicKey && address && publicKey.toBase58() === address;

  const handleCheck = useCallback(async () => {
    setError("");
    setBalances(null);
    setTxSignature("");

    let wallet: PublicKey;
    try {
      wallet = new PublicKey(address);
      if (!PublicKey.isOnCurve(wallet)) throw new Error();
    } catch {
      setError("Invalid Solana wallet address.");
      return;
    }

    setStatus("checking");
    try {
      const result = await checkCashback(connection, wallet);
      setBalances(result);
      setStatus("idle");
      if (result.pumpLamports + result.ammLamports > 0) {
        playCashSound();
        confetti({
          particleCount: 120,
          spread: 80,
          origin: { y: 0.6 },
          colors: ["#34d399", "#6ee7b7", "#a7f3d0", "#fbbf24", "#ffffff"],
        });
      }
    } catch (err) {
      setError(
        `Failed to check cashback: ${err instanceof Error ? err.message : String(err)}`
      );
      setStatus("error");
    }
  }, [address, connection]);

  const handleClaim = useCallback(async () => {
    if (!publicKey || !signTransaction || !balances) return;

    setError("");
    setTxSignature("");
    setStatus("claiming");

    try {
      const feeConfig = getFeeConfig();
      const instructions = buildClaimInstructions(publicKey, balances, feeConfig);
      if (instructions.length === 0) {
        setError("No cashback to claim.");
        setStatus("error");
        return;
      }

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      tx.add(...instructions);

      const signed = await signTransaction(tx);
      const signature = await connection.sendRawTransaction(
        signed.serialize(),
        { skipPreflight: true }
      );

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setTxSignature(signature);
      setStatus("success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("InsufficientFundsForRent") || msg.includes("insufficient funds for rent")) {
        setError(
          "Transaction failed: the fee wallet needs to be funded with at least ~0.001 SOL before it can receive fees. Please fund the fee wallet and try again."
        );
      } else {
        setError(`Claim failed: ${msg}`);
      }
      setStatus("error");
    }
  }, [publicKey, signTransaction, balances, connection]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-4 py-8 sm:py-16">
      <div className="mx-auto w-full max-w-lg">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              Pump Cashback
            </h1>
            <p className="text-sm text-zinc-500 mt-1">
              Check &amp; claim unclaimed cashback rewards
            </p>
          </div>
          <div className="shrink-0">
            <WalletMultiButton />
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-col sm:flex-row gap-2 mb-6">
          <input
            type="text"
            placeholder="Wallet address..."
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={status === "checking"}
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-white
                       placeholder:text-zinc-600 outline-none focus:border-violet-500/50 focus:ring-1
                       focus:ring-violet-500/30 transition disabled:opacity-50 font-mono"
          />
          <button
            onClick={handleCheck}
            disabled={!address || status === "checking"}
            className="rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white
                       hover:bg-violet-500 active:bg-violet-700 transition disabled:opacity-40
                       disabled:cursor-not-allowed sm:w-auto w-full"
          >
            {status === "checking" ? (
              <span className="flex items-center justify-center gap-2">
                <Spinner /> Checking...
              </span>
            ) : (
              "Check"
            )}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Success screen */}
        {status === "success" && txSignature && (
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur-sm overflow-hidden">
            <div className="px-5 py-8 text-center">
              <div className="flex justify-center mb-3">
                <div className="h-14 w-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <svg className="h-7 w-7 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </div>
              </div>
              <p className="text-lg font-semibold text-white mb-1">
                Cashback claimed!
              </p>
              <p className="text-sm text-zinc-400 mb-4">
                {lamportsToSol(totalLamports)} SOL has been sent to your wallet
              </p>
              <a
                href={`https://solscan.io/tx/${txSignature}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-sm text-teal-300 hover:text-teal-200 underline transition mb-6"
              >
                View transaction &rarr;
              </a>
              <div>
                <button
                  onClick={() => {
                    setAddress("");
                    setBalances(null);
                    setTxSignature("");
                    setStatus("idle");
                  }}
                  className="rounded-xl bg-violet-600 px-6 py-3 text-sm font-semibold text-white
                             hover:bg-violet-500 active:bg-violet-700 transition"
                >
                  Check another wallet
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {balances && status !== "success" && (
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/60 backdrop-blur-sm overflow-hidden">
            {hasCashback ? (
              <div className="px-5 py-6">
                {/* Happy icon */}
                <div className="flex justify-center mb-3">
                  <div className="h-14 w-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                    <svg className="h-7 w-7 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                      <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="2.5" />
                      <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="2.5" />
                    </svg>
                  </div>
                </div>

                <p className="text-sm text-zinc-400 text-center mb-1">
                  Unclaimed cashback available
                </p>
                <p className="text-3xl sm:text-4xl font-bold font-mono text-emerald-400 text-center">
                  {lamportsToSol(totalLamports)} SOL
                </p>

                {/* Claim button area */}
                <div className="mt-5">
                  {!publicKey ? (
                    <p className="text-sm text-zinc-500 text-center">
                      Connect your wallet above to claim
                    </p>
                  ) : !isOwnWallet ? (
                    <p className="text-sm text-amber-400/90 text-center leading-relaxed">
                      Connected wallet ({publicKey.toBase58().slice(0, 4)}...
                      {publicKey.toBase58().slice(-4)}) doesn&apos;t match. Connect
                      the correct wallet or re-check your address.
                    </p>
                  ) : (
                    <div>
                      <button
                        onClick={handleClaim}
                        disabled={status === "claiming"}
                        className="w-full rounded-xl bg-emerald-600 px-6 py-3.5 text-sm font-semibold text-white
                                   hover:bg-emerald-500 active:bg-emerald-700 transition disabled:opacity-40
                                   disabled:cursor-not-allowed"
                      >
                        {status === "claiming" ? (
                          <span className="flex items-center justify-center gap-2">
                            <Spinner /> Claiming...
                          </span>
                        ) : (
                          `Claim cashback`
                        )}
                      </button>
                      {totalFee > 0 && (
                        <p className="text-xs text-zinc-600 text-center mt-2">
                          Includes {(FEE_BPS / 100).toFixed(1)}% service fee
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="px-5 py-8 text-center">
                {/* Empty state icon */}
                <div className="flex justify-center mb-3">
                  <div className="h-14 w-14 rounded-full bg-zinc-800/60 flex items-center justify-center">
                    <svg className="h-7 w-7 text-zinc-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="8" y1="15" x2="16" y2="15" />
                      <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="2.5" />
                      <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="2.5" />
                    </svg>
                  </div>
                </div>
                <p className="text-sm text-zinc-500">
                  No unclaimed cashback for this wallet
                </p>
                <p className="text-xs text-zinc-600 mt-2">
                  Try checking a different wallet address
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
