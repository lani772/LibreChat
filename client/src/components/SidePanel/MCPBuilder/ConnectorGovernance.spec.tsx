import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ConnectorGovernance from './ConnectorGovernance';

jest.mock('@librechat/client', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

describe('ConnectorGovernance', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('loads inventory and filters installations by state and search term', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        installations: [{
          id: 'connector-1',
          provider: 'google-workspace',
          displayName: 'Finance Drive',
          ownerId: 'owner-1',
          visibility: 'personal',
          state: 'connected',
          grantedPrincipalCount: 2,
          mcpServerId: null,
          lastConnectedAt: null,
          lastErrorCode: null,
          createdAt: null,
          updatedAt: null,
          version: 3,
        }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ConnectorGovernance />);

    expect(await screen.findByText('Finance Drive')).toBeInTheDocument();
    expect(screen.getByText('2 member(s)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Connection state'), { target: { value: 'revoked' } });
    expect(screen.getByText('No connector installations match these filters.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/connectors/installations', expect.objectContaining({
      credentials: 'include',
      cache: 'no-store',
    }));
  });

  it('loads connector audit events and retrieves older entries using the sequence cursor', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ installations: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entries: [{
            id: 'audit-1',
            action: 'mcp.tool_invoked',
            outcome: 'denied',
            severity: 'warning',
            actor: { type: 'user', id: 'user-1', name: 'Member A' },
            target: { type: 'connector', id: 'connector-1', name: 'Finance Drive' },
            timestamp: '2026-11-10T00:00:00.000Z',
            metadata: { provider: 'google-workspace', reason: 'not_owner' },
            integrity: { seq: 50, hash: 'hash-50', prevHash: 'hash-49' },
          }],
          total: 51,
          nextCursor: 50,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entries: [{
            id: 'audit-2',
            action: 'mcp.tool_invoked',
            outcome: 'success',
            severity: 'info',
            actor: { type: 'user', id: 'user-2', name: 'Member B' },
            target: { type: 'connector', id: 'connector-1', name: 'Finance Drive' },
            timestamp: '2026-11-09T00:00:00.000Z',
            metadata: { provider: 'google-workspace', reason: null },
            integrity: { seq: 49, hash: 'hash-49', prevHash: 'hash-48' },
          }],
          total: 51,
          nextCursor: null,
        }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ConnectorGovernance />);
    fireEvent.click(screen.getByRole('tab', { name: 'Audit history' }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older events' }));
    expect(await screen.findByText('Connector invoked')).toBeInTheDocument();

    await waitFor(() => expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/admin/connectors/audit?limit=50&cursor=50',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    ));
  });

  it('does not render secret metadata from the audit API response', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ installations: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          entries: [{
            id: 'audit-secret',
            action: 'mcp.tool_invoked',
            outcome: 'denied',
            severity: 'warning',
            actor: { type: 'user', id: null, name: 'Member' },
            target: { type: 'connector', id: null, name: null },
            timestamp: '2026-11-10T00:00:00.000Z',
            metadata: { provider: 'google-workspace', reason: 'not_owner', token: 'do-not-render' },
            integrity: { seq: 1, hash: 'hash', prevHash: 'prev' },
          }],
          total: 1,
          nextCursor: null,
        }),
      }) as unknown as typeof fetch;

    render(<ConnectorGovernance />);
    fireEvent.click(screen.getByRole('tab', { name: 'Audit history' }));

    expect(await screen.findByText('Access denied')).toBeInTheDocument();
    expect(screen.queryByText('do-not-render')).not.toBeInTheDocument();
  });
});
