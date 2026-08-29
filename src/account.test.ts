import { describe, expect, it, vi } from 'vitest';
import { AccountDeletionError, requestAccountDeletion } from './account.js';

describe('requestAccountDeletion', () => {
  it('returns durable deletion acceptance', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      message: 'Account deletion is in progress',
      requestId: 'request-id',
      state: 'DELETING',
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestAccountDeletion(
      'https://api.example.test/v1/',
      'firebase-token',
      fetchImplementation,
    )).resolves.to.deep.equal({
      message: 'Account deletion is in progress',
      requestId: 'request-id',
      state: 'DELETING',
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.example.test/v1/account',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer firebase-token' }),
      }),
    );
  });

  it('preserves message, code, and details from API failures', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
      message: 'Please sign in again.',
      code: 'REAUTHENTICATION_REQUIRED',
      details: ['Authentication must be recent.'],
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));

    try {
      await requestAccountDeletion('https://api.example.test/v1', 'token', fetchImplementation);
      expect.fail('expected account deletion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AccountDeletionError);
      expect(error).toMatchObject({
        message: 'Please sign in again.',
        code: 'REAUTHENTICATION_REQUIRED',
        details: ['Authentication must be recent.'],
        status: 401,
      });
    }
  });
});