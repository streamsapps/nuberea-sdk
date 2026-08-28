import { randomUUID } from 'node:crypto';

export type SubscriptionBillingCycle = 'monthly' | 'yearly';

export interface SubscriptionCheckout {
  sessionId: string;
  url: string;
  billingCycle: SubscriptionBillingCycle;
}

export interface BillingClientConfig {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
}

export class BillingClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string>;
  private readonly fetch: typeof fetch;

  constructor(config: BillingClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.getToken = config.getToken;
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async createSubscriptionCheckout(
    billingCycle: SubscriptionBillingCycle,
    options?: { checkoutAttemptId?: string },
  ): Promise<SubscriptionCheckout> {
    if (billingCycle !== 'monthly' && billingCycle !== 'yearly') {
      throw new Error('billingCycle must be monthly or yearly');
    }

    const response = await this.fetch(`${this.baseUrl}/stripe/checkout-link`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        billingCycle,
        checkoutAttemptId: options?.checkoutAttemptId ?? randomUUID(),
      }),
    });

    const body = await parseResponse(response);
    if (!response.ok) {
      const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
      throw new Error(`Unable to create subscription checkout: ${message}`);
    }

    if (
      typeof body.sessionId !== 'string'
      || !isStripeHostedUrl(body.url)
      || body.billingCycle !== billingCycle
    ) {
      throw new Error('Subscription API returned an invalid Stripe Checkout response');
    }

    return {
      sessionId: body.sessionId,
      url: body.url,
      billingCycle,
    };
  }
}

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isStripeHostedUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'));
  } catch {
    return false;
  }
}