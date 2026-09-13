export interface AccountDeletionAcceptance {
  message: string;
  requestId: string;
  state: 'DELETING' | 'DELETE_BLOCKED';
}

interface ErrorResponse {
  message?: string;
  code?: string;
  details?: string[];
}

export class AccountDeletionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: string[],
    readonly status: number,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export async function requestAccountDeletion(
  accountApiBaseUrl: string,
  firebaseIdToken: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<AccountDeletionAcceptance> {
  const response = await fetchImplementation(`${accountApiBaseUrl.replace(/\/$/, '')}/account`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${firebaseIdToken}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await response.json().catch(() => ({})) as ErrorResponse & Partial<AccountDeletionAcceptance>;
  if (!response.ok) {
    throw new AccountDeletionError(
      body.message || `Account deletion failed with HTTP ${response.status}.`,
      body.code || 'ACCOUNT_DELETION_FAILED',
      Array.isArray(body.details) ? body.details : [],
      response.status,
    );
  }

  if (
    response.status !== 202
    || typeof body.message !== 'string'
    || typeof body.requestId !== 'string'
    || (body.state !== 'DELETING' && body.state !== 'DELETE_BLOCKED')
  ) {
    throw new AccountDeletionError(
      'The account deletion response was invalid.',
      'INVALID_ACCOUNT_DELETION_RESPONSE',
      [],
      response.status,
    );
  }

  return {
    message: body.message,
    requestId: body.requestId,
    state: body.state,
  };
}