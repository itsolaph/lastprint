import { Attribution } from 'ox/erc8021';

// Base Builder Code for Lastprint (registered on dashboard.base.org).
// Appended to calldata as an ERC-8021 suffix so Base can attribute fills,
// approvals and cancels to this app. Contracts ignore the trailing bytes.
export const BUILDER_CODE = 'bc_89bpejq7';

export const DATA_SUFFIX = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });
