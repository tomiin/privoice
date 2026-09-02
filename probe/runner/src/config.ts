// src/config.ts — PREVIEW endpoints, network id, token scales.
//
// The probe deliberately targets Preview: it is where Quest 10 must deploy,
// and where nobody has yet tested servicedesk #117.
import { NetworkId } from '@midnight-ntwrk/wallet-sdk';

// Verified against wallet-sdk-abstractions/dist/NetworkId.d.ts:
//   readonly Preview: "preview"    readonly PreProd: "preprod"
export const NETWORK_ID = NetworkId.NetworkId.Preview;

export const networkConfig = {
  indexerHttpUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWsUrl:   'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node:           'wss://rpc.preview.midnight.network',
  proofServer:    process.env.PROOF_SERVER ?? 'http://localhost:6300',
};

// Token scales
export const MICRO_NIGHT = 1_000_000n;             // 1 NIGHT = 10^6 micro-NIGHT
export const DUST_SPECKS = 1_000_000_000_000_000n; // 1 DUST  = 10^15 specks
