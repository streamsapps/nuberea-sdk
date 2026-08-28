import { describe, expect, it, vi } from 'vitest';
import { BillingClient } from './billing.js';

describe('BillingClient', () => {
  it('creates an authenticated monthly Checkout link with a UUID attempt ID', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(init?.headers).toEqual({
        Authorization: 'Bearer oauth-token',
        'Content-Type': 'application/json',
      });
      expect(body.billingCycle).toBe('monthly');
      expect(body.checkoutAttemptId).toMatch(/^[0-9a-f-]{36}$/);
      return Response.json({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        billingCycle: 'monthly',
      });
    });
    const client = new BillingClient({
      baseUrl: 'https://billing.example.test/',
      getToken: async () => 'oauth-token',
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(client.createSubscriptionCheckout('monthly')).resolves.toEqual({
      sessionId: 'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
      billingCycle: 'monthly',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://billing.example.test/stripe/checkout-link',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('forwards a stable caller-supplied checkout attempt ID', async () => {
    const attemptId = '123e4567-e89b-42d3-a456-426614174000';
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ checkoutAttemptId: attemptId });
      return Response.json({
        sessionId: 'cs_test_123',
        url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        billingCycle: 'yearly',
      });
    });
    const client = new BillingClient({
      baseUrl: 'https://billing.example.test',
      getToken: async () => 'oauth-token',
      fetch: fetch as typeof globalThis.fetch,
    });

    await client.createSubscriptionCheckout('yearly', { checkoutAttemptId: attemptId });
  });

  it('rejects non-Stripe redirect URLs from a compromised response', async () => {
    const client = new BillingClient({
      baseUrl: 'https://billing.example.test',
      getToken: async () => 'oauth-token',
      fetch: async () => Response.json({
        sessionId: 'cs_test_123',
        url: 'https://stripe.com.evil.example/checkout',
        billingCycle: 'monthly',
      }),
    });

    await expect(client.createSubscriptionCheckout('monthly')).rejects.toThrow(
      'invalid Stripe Checkout response',
    );
  });

  it('surfaces API conflicts without exposing response internals', async () => {
    const client = new BillingClient({
      baseUrl: 'https://billing.example.test',
      getToken: async () => 'oauth-token',
      fetch: async () => Response.json(
        { message: 'You already have an active subscription', provider: 'apple' },
        { status: 409 },
      ),
    });

    await expect(client.createSubscriptionCheckout('monthly')).rejects.toThrow(
      'Unable to create subscription checkout: You already have an active subscription',
    );
  });
});