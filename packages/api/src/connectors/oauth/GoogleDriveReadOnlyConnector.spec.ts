import { GoogleDriveReadOnlyConnector } from './GoogleDriveReadOnlyConnector';

const INSTALLATION_ID = '507f1f77bcf86cd799439011';
const SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('GoogleDriveReadOnlyConnector', () => {
  const execute = jest.fn(async (_id: string, operation: (connector: unknown) => Promise<unknown>) =>
    operation({ installation: { _id: INSTALLATION_ID } }));
  const withCredentials = jest.fn(async (_id: string, operation: (credentials: Record<string, unknown>) => Promise<unknown>) =>
    operation({ scopes: [SCOPE] }));
  const getAccessToken = jest.fn().mockResolvedValue('short-lived-access-token');
  const fetcher = jest.fn();
  let connector: GoogleDriveReadOnlyConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new GoogleDriveReadOnlyConnector({
      connectors: { execute },
      vault: { withCredentials },
      tokenLifecycle: { getAccessToken },
      fetcher,
    });
  });

  it('lists metadata with bounded pagination and a read-only GET', async () => {
    fetcher.mockResolvedValue(response(200, {
      files: [{ id: 'f1', name: 'Report', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/f1' }],
      nextPageToken: 'next-page',
    }));
    const result = await connector.listFiles({
      installationId: INSTALLATION_ID, query: "name contains 'Report'", pageSize: 20,
    });
    expect(result.files[0]).toMatchObject({ id: 'f1', name: 'Report', mimeType: 'application/pdf' });
    expect(result.nextPageToken).toBe('next-page');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('pageSize=20'), expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer short-lived-access-token' }),
    }));
  });

  it('retrieves metadata for a safely encoded file ID', async () => {
    fetcher.mockResolvedValue(response(200, { id: 'a/b', name: 'Document' }));
    await expect(connector.getFile({ installationId: INSTALLATION_ID, fileId: 'a/b' }))
      .resolves.toMatchObject({ id: 'a/b', name: 'Document' });
    expect(fetcher.mock.calls[0][0]).toContain('/files/a%2Fb');
  });

  it('rejects missing Drive metadata scope before calling Google', async () => {
    withCredentials.mockImplementationOnce(async (_id, operation) => operation({ scopes: [] }));
    await expect(connector.listFiles({ installationId: INSTALLATION_ID }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE', statusCode: 403 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('enforces the connector authorization boundary before provider access', async () => {
    execute.mockRejectedValueOnce(new Error('denied'));
    await expect(connector.listFiles({ installationId: INSTALLATION_ID })).rejects.toThrow('denied');
    expect(withCredentials).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects invalid page sizes and malformed installation IDs', async () => {
    await expect(connector.listFiles({ installationId: INSTALLATION_ID, pageSize: 101 }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(connector.getFile({ installationId: 'not-an-id', fileId: 'f1' }))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not expose provider response bodies on errors', async () => {
    fetcher.mockResolvedValue(response(403, { error: { message: 'sensitive provider details' } }));
    await expect(connector.listFiles({ installationId: INSTALLATION_ID }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_SCOPE' });
  });
});
