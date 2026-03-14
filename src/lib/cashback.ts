import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";

export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const CLAIM_CASHBACK_DISCRIMINATOR = Buffer.from([
  37, 58, 35, 126, 190, 53, 228, 197,
]);

function getUserAccumulatorPda(
  wallet: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), wallet.toBuffer()],
    programId
  );
}

function getEventAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );
}

export interface CashbackBalances {
  /** Unclaimed bonding curve cashback in lamports */
  pumpLamports: number;
  /** Unclaimed AMM cashback in lamports (WSOL) */
  ammLamports: number;
  /** Whether the pump accumulator account exists */
  pumpAccExists: boolean;
  /** Whether the AMM accumulator account exists */
  ammAccExists: boolean;
}

export async function checkCashback(
  connection: Connection,
  wallet: PublicKey
): Promise<CashbackBalances> {
  // Pump program (bonding curve): lamports in accumulator minus rent
  const [pumpAccPda] = getUserAccumulatorPda(wallet, PUMP_PROGRAM_ID);
  const pumpAccInfo = await connection.getAccountInfo(pumpAccPda);
  let pumpLamports = 0;
  const pumpAccExists = pumpAccInfo !== null;
  if (pumpAccInfo) {
    const rentExempt = await connection.getMinimumBalanceForRentExemption(
      pumpAccInfo.data.length
    );
    pumpLamports = Math.max(0, pumpAccInfo.lamports - rentExempt);
  }

  // PumpSwap AMM: WSOL balance of accumulator's ATA
  const [ammAccPda] = getUserAccumulatorPda(wallet, PUMP_AMM_PROGRAM_ID);
  const ammAccInfo = await connection.getAccountInfo(ammAccPda);
  const ammAccExists = ammAccInfo !== null;
  let ammLamports = 0;
  if (ammAccExists) {
    const accumulatorWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      ammAccPda,
      true // allowOwnerOffCurve
    );
    try {
      const balance = await connection.getTokenAccountBalance(
        accumulatorWsolAta
      );
      ammLamports = Number(balance.value.amount);
    } catch {
      // ATA doesn't exist = no cashback
    }
  }

  return { pumpLamports, ammLamports, pumpAccExists, ammAccExists };
}

export interface FeeConfig {
  /** Fee recipient wallet */
  wallet: PublicKey;
  /** Fee in basis points (e.g. 10 = 0.1%) */
  bps: number;
}

export function calculateFee(lamports: number, bps: number): number {
  return Math.floor((lamports * bps) / 10_000);
}

export function buildClaimInstructions(
  user: PublicKey,
  balances: CashbackBalances,
  fee?: FeeConfig
): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = [];

  // Claim from Pump bonding curve program
  if (balances.pumpLamports > 0) {
    const [userVolumeAcc] = getUserAccumulatorPda(user, PUMP_PROGRAM_ID);
    const [eventAuthority] = getEventAuthorityPda(PUMP_PROGRAM_ID);

    instructions.push(
      new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: user, isSigner: false, isWritable: true },
          { pubkey: userVolumeAcc, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: CLAIM_CASHBACK_DISCRIMINATOR,
      })
    );

    // Fee transfer: native SOL via SystemProgram
    if (fee && fee.bps > 0) {
      const feeLamports = calculateFee(balances.pumpLamports, fee.bps);
      if (feeLamports > 0) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: fee.wallet,
            lamports: feeLamports,
          })
        );
      }
    }
  }

  // Claim from PumpSwap AMM program
  if (balances.ammLamports > 0) {
    const [userVolumeAcc] = getUserAccumulatorPda(user, PUMP_AMM_PROGRAM_ID);
    const [eventAuthority] = getEventAuthorityPda(PUMP_AMM_PROGRAM_ID);

    const accumulatorWsolAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      userVolumeAcc,
      true
    );
    const userWsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user, false);

    // Create user's WSOL ATA if it doesn't exist
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        user, // payer
        userWsolAta,
        user,
        NATIVE_MINT
      )
    );

    instructions.push(
      new TransactionInstruction({
        programId: PUMP_AMM_PROGRAM_ID,
        keys: [
          { pubkey: user, isSigner: false, isWritable: true },
          { pubkey: userVolumeAcc, isSigner: false, isWritable: true },
          { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: accumulatorWsolAta, isSigner: false, isWritable: true },
          { pubkey: userWsolAta, isSigner: false, isWritable: true },
          {
            pubkey: SystemProgram.programId,
            isSigner: false,
            isWritable: false,
          },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: CLAIM_CASHBACK_DISCRIMINATOR,
      })
    );

    // Unwrap WSOL → native SOL by closing the user's WSOL ATA
    instructions.push(
      createCloseAccountInstruction(
        userWsolAta, // account to close
        user,        // destination for remaining lamports
        user         // owner/authority
      )
    );

    // Fee transfer: native SOL (after unwrap) via SystemProgram
    if (fee && fee.bps > 0) {
      const feeLamports = calculateFee(balances.ammLamports, fee.bps);
      if (feeLamports > 0) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: fee.wallet,
            lamports: feeLamports,
          })
        );
      }
    }
  }

  return instructions;
}

export function lamportsToSol(lamports: number): string {
  const val = lamports / 1e9;
  // If very small (< 0.001), show full precision so it's not "0"
  if (val > 0 && val < 0.01) {
    return val.toString();
  }
  return parseFloat(val.toFixed(3)).toString();
}
