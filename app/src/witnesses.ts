// Witness implementations for privoice.compact.
//
// A witness runs LOCALLY. Its return value feeds the circuit as a private
// input and never reaches the chain. The signature is fixed by compact-js:
//
//   (context: WitnessContext<Ledger, PS>, ...args) => [PS, ReturnValue]
//
// The first element is the (possibly updated) private state; the second is the
// value handed to the circuit. Nothing here mutates state, so every witness
// returns the private state it was given, unchanged.
//
// Compact -> TypeScript type mapping used below:
//   Bytes<32> -> Uint8Array (exactly 32 bytes)
//   Uint<64>  -> bigint

export type PrivoicePrivateState = {
  /** The caller's identity key. Issuer and payer each have their own. */
  secretKey: Uint8Array;
  /** The four fields behind the commitment, for the invoice being acted on. */
  amount: bigint;
  payer: Uint8Array;
  memo: Uint8Array;
  salt: Uint8Array;
};

type Ctx = { privateState: PrivoicePrivateState };

export const witnesses = {
  localSecretKey: (ctx: Ctx): [PrivoicePrivateState, Uint8Array] =>
    [ctx.privateState, ctx.privateState.secretKey],

  localAmount: (ctx: Ctx): [PrivoicePrivateState, bigint] =>
    [ctx.privateState, ctx.privateState.amount],

  localPayer: (ctx: Ctx): [PrivoicePrivateState, Uint8Array] =>
    [ctx.privateState, ctx.privateState.payer],

  localMemo: (ctx: Ctx): [PrivoicePrivateState, Uint8Array] =>
    [ctx.privateState, ctx.privateState.memo],

  localSalt: (ctx: Ctx): [PrivoicePrivateState, Uint8Array] =>
    [ctx.privateState, ctx.privateState.salt],
};
