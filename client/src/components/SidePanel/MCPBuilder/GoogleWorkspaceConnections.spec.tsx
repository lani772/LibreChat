import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import GoogleWorkspaceConnections from './GoogleWorkspaceConnections';

describe('GoogleWorkspaceConnections', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    window.history.replaceState({}, '', '/');
    jest.clearAllMocks();
  });

  it('loads only the safe installation list and shows the empty state', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ installations: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<GoogleWorkspaceConnections />);

    expect(await screen.findByText('No Google Workspace accounts connected yet.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/connectors/google-workspace', expect.objectContaining({
      credentials: 'include',
      cache: 'no-store',
    }));
  });

  it('renders safe owner connection state and offers disconnect for connected accounts', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        installations: [{
          id: '507f1f77bcf86cd799439011',
          displayName: 'Work Drive',
          state: 'connected',
          version: 2,
          grantedPrincipalIds: [],
        }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<GoogleWorkspaceConnections />);

    expect(await screen.findByText('Work Drive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  it('shows the last health observation and consecutive failure count', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        installations: [{
          id: '507f1f77bcf86cd799439011',
          displayName: 'Health monitored Drive',
          state: 'degraded',
          version: 3,
          lastHealthCheckAt: '2026-11-09T10:00:00.000Z',
          lastSuccessfulHealthCheckAt: '2026-11-09T09:55:00.000Z',
          consecutiveHealthFailures: 2,
          lastErrorCode: 'provider_unavailable',
          grantedPrincipalIds: [],
        }],
      }),
    }) as unknown as typeof fetch;
    render(<GoogleWorkspaceConnections />);
    expect(await screen.findByText(/Consecutive failures: 2/)).toBeInTheDocument();
    expect(screen.getByText(/Last check:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check health' })).toBeInTheDocument();
  });

  it('searches tenant members and submits selected member grants with the installation version', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          installations: [{
            id: '507f1f77bcf86cd799439011',
            displayName: 'Work Drive',
            state: 'connected',
            version: 4,
            grantedPrincipalIds: [],
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          members: [{
            id: '507f191e810c19729de860ea',
            name: 'Member A',
            username: 'membera',
            email: 'membera@example.test',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ version: 5 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ installations: [] }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<GoogleWorkspaceConnections />);
    const search = await screen.findByLabelText('Find tenant members by name, username, or email');
    fireEvent.change(search, { target: { value: 'member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));

    const checkbox = await screen.findByRole('checkbox');
    expect(screen.getByText('membera@example.test')).toBeInTheDocument();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/connectors/google-workspace/507f1f77bcf86cd799439011/members?q=member',
      expect.objectContaining({ credentials: 'include', cache: 'no-store' }),
    ));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/connectors/google-workspace/507f1f77bcf86cd799439011/grants',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({
          expectedVersion: 4,
          principalIds: ['507f191e810c19729de860ea'],
        }),
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Connector sharing permissions updated.');
  });

  it('shows a safe error when the installation list cannot be loaded', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    render(<GoogleWorkspaceConnections />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Google Workspace could not complete the request. Please try again.',
    );
  });
});
