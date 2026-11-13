# Threat model: LastprintOrders

Scope: `contracts/src/LastprintOrders.sol` and the offchain keeper that fills it. The contract has no owner, no admin, no fees and no upgrade path. Configuration (ActionFeed address, guard window, router allowlist) is fixed at deployment.

## Assets and invariants

What is at risk: maker tokens approved to the contract (USDC or B20 stock tokens).

1. The contract pulls exactly `amountIn` of `tokenIn` from the maker, and only inside a `fill` of a valid signed order.
2. The maker receives at least `minAmountOut` of `tokenOut`. This is measured by balance delta, both at the contract and at the maker.
3. An order fills at most once (nonce). It never fills outside `[validAfter, validUntil)`.
4. An order never fills while a B20 multiplier change is about to go live within `guardWindow`, or while transfers are paused. An order never fills at a multiplier other than the one the maker signed.
5. After every fill the contract holds no allowance to the router and no tokens from the fill.

## Trust assumptions

| Party | Trusted for | Not trusted for |
|---|---|---|
| Deployer | Choosing the router allowlist once (see "Misconfiguration") | Nothing after deployment; there are no privileged functions |
| ActionFeed (`0xC455…6Fe2`, ownerless) | Reporting the live multiplier, pending changes and pause state | Funds: it is only called with `staticcall` (view) |
| Allowlisted router (Aerodrome Slipstream SwapRouter) | Swapping only from `msg.sender`, using the allowance it is given | Price: output is checked by balance delta |
| Filler / keeper | Liveness only | Anything else; filling is permissionless |
| Price sources (Yahoo, Nasdaq) | Displaying the reference close in the UI | Execution: the signed `minAmountOut` is absolute |

## Threats and mitigations

Each row names the tests that cover it. Contract tests are in `contracts/test/LastprintOrders.t.sol` unless noted. Keeper tests are in `keeper/test/`.

| # | Threat | Mitigation | Tests |
|---|---|---|---|
| 1 | **Malicious filler** submits a worse price | `minAmountOut` is checked against the contract's own `tokenOut` balance delta. The maker's balance delta is checked again after payout. | `test_revert_minOutNotMet`, `testFuzz_buy`, `testFuzz_sellWithPartialSpend`, `test_fill_exactlyMinOut` |
| 2 | **Malicious calldata**: send the output elsewhere, overspend the allowance, or pull from the maker directly | The router is approved for exactly `amountIn` and only during the call, and the approval is reset to 0 afterwards. The maker never approves the router. Output sent elsewhere fails the balance-delta check. | `test_revert_maliciousCalldata_outputToAttacker`, `…_overpull`, `…_pullFromMaker`, `test_leftoverRefund_andApprovalReset` |
| 3 | **Arbitrary target**: a token address used as the "router" to call `transferFrom(victim, attacker)` with every maker's allowance | The router allowlist is immutable and checked on every fill. The constructor rejects contracts that answer `totalSupply()`, the feed itself, EOAs and duplicates. The deploy script also requires `factory()` and `WETH9()`. | `test_revert_tokenAsRouterNotAllowlisted`, `test_revert_routerNotAllowlisted`, `test_revert_constructor_badConfig` |
| 4 | **ERC-6492 factory call** used to make the contract call `transferFrom` | The wrapper's factory call is never executed. A wrapped signature is accepted only if the maker is already deployed; the inner signature is then checked via ERC-1271. | `test_erc6492_wrappedSignature_deployedWallet` (wrapper points at USDC `transferFrom`; attacker gets 0), `test_revert_erc6492_undeployedWallet` |
| 5 | **Reentrancy** through the router or a hook token | `nonReentrant` (transient storage) on `fill`. The nonce is consumed before any external call. | `test_revert_reentrancyViaRouter`, `test_reentrancyViaToken_blocked` |
| 6 | **Fee-on-transfer / deflationary tokens** | `tokenIn`: the received delta must equal `amountIn`. `tokenOut`: the maker's received delta must be at least `minAmountOut`. Either failure reverts with `UnsupportedToken` or `InsufficientOutput`. | `test_revert_feeOnTransferTokenIn`, `test_revert_feeOnTransferTokenOut`, `test_revert_feeOnTransferTokenOut_payoutLeg` |
| 7 | **Rebasing tokens** | Not supported: amounts are raw balances. B20 multipliers do not rebase raw balances (only the UI multiplier changes), so B20 is unaffected. Positive rebases mid-transaction are not a realistic case. | Covered by the multiplier tests below |
| 8 | **Tokens without a bool return** (USDT-style), and zero-first approve | OpenZeppelin `SafeERC20` plus `forceApprove` | `test_noReturnToken_works` |
| 9 | **Multiplier change mid-order** (split or dividend accrual between signing and fill) | `ActionFeed.status(stockToken).uiMultiplier` must equal the signed `stockMultiplier`. Once a change goes live the order can never fill. The keeper marks such orders void. | `test_revert_multiplierMismatch`, `test_revert_multiplierChangedAfterSigning`; keeper: `voids an order whose multiplier no longer matches` |
| 10 | **Pending corporate action** (filling just before a split goes live, against a pool still priced on the old basis) | `ActionFeed.assertStable(stockToken, guardWindow)` reverts if a change goes live within `guardWindow` | `test_revert_pendingActionWithinWindow`, `test_revert_pendingActionAtWindowEdge`, `test_pendingActionOutsideWindow_fills` |
| 11 | **Paused transfers** | `assertStable` reverts when transfers are paused | `test_revert_pausedTransfers` |
| 12 | **Guard bypass** by pointing `stockToken` at an unrelated token | `stockToken` must be `tokenIn` or `tokenOut` | `test_revert_stockTokenNotInPair` |
| 13 | **Replay**: same order twice, another order with the same nonce, another chain, another deployment | Per-maker nonces, consumed on fill. The EIP-712 domain includes `chainId` and `verifyingContract`, and OZ `EIP712` rebuilds it after a fork. | `test_revert_replay`, `test_revert_sameNonceDifferentOrder`, `test_revert_crossChainReplay`, `test_revert_crossContractReplay` |
| 14 | **Signature forgery or malleability** | OZ `ECDSA.tryRecover` rejects high-s and malformed signatures. Contract wallets use ERC-1271 with the exact magic value. EIP-7702 accounts may still sign with their key. | `test_revert_wrongSigner`, `test_revert_tamperedOrder`, `test_revert_highSMalleableSignature`, `test_revert_garbageSignature`, `test_erc1271_smartWallet`, `test_revert_erc1271_wrongOwner`, `test_revert_erc1271_badMagic`, `test_eip7702_delegatedEoa_canStillSignWithKey`; keeper `signature.test.ts` mirrors all of these |
| 15 | **Time window abuse** (filling during the US session or after the opening bell) | The contract enforces `[validAfter, validUntil)`. The keeper API accepts only windows inside the current closed-market window, ending at or before the next open. The UI signs `validAfter = last close` and `validUntil = next open`. | `test_revert_beforeValidAfter`, `test_revert_atValidUntil`, `testFuzz_nonceAndWindow`; keeper `orders.test.ts` (market open, expiry after the opening bell, start before close) |
| 16 | **Cancellation** | `cancel(nonce)` and `cancelUpTo(minNonce)` (which must increase). Each affects only the caller's own nonces. | `test_cancel`, `test_cancelUpTo`, `test_cancel_onlyAffectsCaller` |
| 17 | **Front-running** | A copied fill transaction gives the maker the same guarantee, so it is harmless. A fill that front-runs an onchain cancel still pays the maker at least the limit; this is inherent to signed orders, so the UI explains it and offers onchain cancel. A filler can sandwich the pool down to exactly `minAmountOut` or route through its own pools, capturing any surplus above the limit. The maker still gets their limit price, so the protection is the limit itself. Base's sequencer orders by priority fee, with no public mempool. | Design property; covered by tests 1–2 |
| 18 | **Stray balances** (donations) | Balance snapshots before the pull mean donated tokens are never counted or paid out (they stay stuck) | `test_donatedBalancesAreNotPaidOut` |
| 19 | **Router failure** | The revert data is bubbled up as `RouterCallFailed(bytes)` and the whole transaction rolls back, including the nonce | `test_revert_routerFailureBubbles`, `test_revert_minOutNotMet` (nonce rolled back) |

## Keeper-specific risks

- **Key handling.** `KEEPER_PRIVATE_KEY` is read from the environment and never logged; the config parser does not echo it. Without a key the keeper is watch-only. The keeper key holds only gas money and can do nothing but call `fill`, which is permissionless anyway.
- **Doomed fills (gas waste).** Before sending, the keeper simulates `fill` with `eth_call`. It enforces gas-limit and fee caps, keeps one fill in flight per order (in memory plus an atomic DB `open → filling` transition), and backs off exponentially.
- **Offchain cancel.** This only stops this keeper. The signed order stays valid onchain until it expires. The API does not expose stored signatures, so third parties cannot obtain them from us. The UI offers an onchain `cancel(nonce)` for a hard guarantee.
- **Data sources.** The close shown in the UI comes from unofficial endpoints, and the UI shows its source and freshness. A wrong close only affects the limit the user chooses to sign. It never moves funds by itself, and the API rejects limits more than 30% from the close.

## Misconfiguration (deployment)

The router allowlist is permanent. Every entry must be a swap router that only spends tokens from `msg.sender`. Do not allowlist:

- a token;
- a contract with arbitrary-call functionality;
- a router with "pull from any address via Permit2" commands.

Any of these would let fill calldata spend other makers' allowances. The constructor's `totalSupply()` probe and the deploy script's `factory()`/`WETH9()` check are heuristics, not proofs. Review the list by hand before deploying.

## Not covered

- Real B20 tokens: they are precompile-style, so forked-mainnet tests may not run them correctly. They must be verified onchain with small amounts before launch.
- Exact ActionFeed semantics: tested against a mock that follows the published interface.
- ERC-6492 counterfactual deployment inside `fill`: deliberately unsupported (see threat 4).
