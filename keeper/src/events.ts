import { EventEmitter } from 'node:events';

export interface FillEvent {
  orderHash: string;
  maker: string;
  ticker: string | null;
  side: 'buy' | 'sell' | null;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  filler: string;
  txHash: string;
  blockNumber: number;
}

export interface ExpiryEvent {
  orderHash: string;
  maker: string;
  ticker: string;
  side: 'buy' | 'sell';
  reason: string;
}

export interface BusEvents {
  fill: [FillEvent];
  expired: [ExpiryEvent];
}

export class Bus extends EventEmitter<BusEvents> {
  constructor() {
    super();
    this.setMaxListeners(1000);
  }
}
