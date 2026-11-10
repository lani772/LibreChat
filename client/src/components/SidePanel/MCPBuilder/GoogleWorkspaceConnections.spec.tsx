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

  it('submits owner-managed tenant grants with the installation version', async () => {
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
        json: async () => ({ version: 5 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ installations: [] }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<GoogleWorkspaceConnections />);
    const input = await screen.findByLabelText('Tenant member user IDs for Work Drive');
    fireEvent.change(input, { target: { value: '507f191e810c19729de860ea' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sharing' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/connectors/google-workspace/507f1f77bcf86cd799439011/grants',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        body: JSON.stringify({
          expectedVersion: 4,
          principalIds: ['507f191e810c19729de860ea'],
        }),
      }),
    ));
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
