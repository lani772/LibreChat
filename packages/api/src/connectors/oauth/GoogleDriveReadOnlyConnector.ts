import type { ConnectorCredentialVault } from '../ConnectorCredentialVault';
import type { ConnectorService } from '../ConnectorService';
import type { GoogleWorkspaceTokenLifecycle } from './GoogleWorkspaceTokenLifecycle';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGE_SIZE = 100;
const MAX_QUERY_LENGTH = 1_000;
const MAX_PAGE_TOKEN_LENGTH = 4_096;
const FILE_FIELDS = 'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,parents,trashed)';
const METADATA_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,iconLink,parents,trashed';

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  iconLink?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface GoogleDriveListResult {
  files: GoogleDriveFile[];
  nextPageToken?: string;
  incompleteSearch: boolean;
}

export class GoogleDriveReadOnlyError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INSUFFICIENT_SCOPE' | 'PROVIDER_UNAVAILABLE' | 'INVALID_RESPONSE',
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'GoogleDriveReadOnlyError';
  }
}

interface GoogleDriveResponse {
  files?: unknown;
  nextPageToken?: unknown;
  incompleteSearch?: unknown;
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  size?: unknown;
  webViewLink?: unknown;
  iconLink?: unknown;
  parents?: unknown;
  trashed?: unknown;
}

function safeFile(value: unknown): GoogleDriveFile {
  if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string' ||
      typeof (value as { name?: unknown }).name !== 'string') {
    throw new GoogleDriveReadOnlyError('Google Drive returned an invalid file record', 'INVALID_RESPONSE', 502);
  }
  const file = value as GoogleDriveResponse;
  return {
    id: file.id as string,
    name: file.name as string,
    ...(typeof file.mimeType === 'string' ? { mimeType: file.mimeType } : {}),
    ...(typeof file.modifiedTime === 'string' ? { modifiedTime: file.modifiedTime } : {}),
    ...(typeof file.size === 'string' ? { size: file.size } : {}),
    ...(typeof file.webViewLink === 'string' ? { webViewLink: file.webViewLink } : {}),
    ...(typeof file.iconLink === 'string' ? { iconLink: file.iconLink } : {}),
    ...(Array.isArray(file.parents) && file.parents.every((item) => typeof item === 'string')
      ? { parents: file.parents as string[] } : {}),
    ...(typeof file.trashed === 'boolean' ? { trashed: file.trashed } : {}),
  };
}

function validateInstallationId(value: string): void {
  if (!/^[a-f\d]{24}$/i.test(value)) {
    throw new GoogleDriveReadOnlyError('Invalid connector installation', 'NOT_FOUND', 404);
  }
}

export interface GoogleDriveReadOnlyDependencies {
  connectors: Pick<ConnectorService, 'execute'>;
  tokenLifecycle: Pick<GoogleWorkspaceTokenLifecycle, 'getAccessToken'>;
  vault: Pick<ConnectorCredentialVault, 'withCredentials'>;
  fetcher?: typeof fetch;
}

/**
 * Read-only Google Drive metadata API. Every operation is authorized against the
 * trusted connector identity before credentials are read or Google is contacted.
 */
export class GoogleDriveReadOnlyConnector {
  private readonly fetcher: typeof fetch;

  constructor(private readonly deps: GoogleDriveReadOnlyDependencies) {
    this.fetcher = deps.fetcher ?? fetch;
  }

  async listFiles(input: {
    installationId: string;
    query?: string;
    pageSize?: number;
    pageToken?: string;
    orderBy?: 'name' | 'modifiedTime' | 'createdTime' | 'name_natural';
  }): Promise<GoogleDriveListResult> {
    validateInstallationId(input.installationId);
    const query = input.query?.trim() ?? '';
    if (query.length > MAX_QUERY_LENGTH) {
      throw new GoogleDriveReadOnlyError('Drive search query is too long', 'INVALID_RESPONSE', 400);
    }
    const pageSize = input.pageSize ?? 25;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      throw new GoogleDriveReadOnlyError('Drive page size must be between 1 and 100', 'INVALID_RESPONSE', 400);
    }
    if (input.pageToken && input.pageToken.length > MAX_PAGE_TOKEN_LENGTH) {
      throw new GoogleDriveReadOnlyError('Drive page token is invalid', 'INVALID_RESPONSE', 400);
    }

    return this.deps.connectors.execute(input.installationId, async (connector) => {
      await this.assertReadOnlyScope(input.installationId);
      const accessToken = await this.deps.tokenLifecycle.getAccessToken(input.installationId);
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('fields', FILE_FIELDS);
      url.searchParams.set('q', query || 'trashed = false');
      url.searchParams.set('orderBy', input.orderBy ?? 'modifiedTime desc');
      if (input.pageToken) url.searchParams.set('pageToken', input.pageToken);
      return this.request<GoogleDriveListResult>(url, accessToken, (body) => {
        if (!Array.isArray(body.files)) {
          throw new GoogleDriveReadOnlyError('Google Drive returned an invalid file list', 'INVALID_RESPONSE', 502);
        }
        return {
          files: body.files.map(safeFile),
          ...(typeof body.nextPageToken === 'string' ? { nextPageToken: body.nextPageToken } : {}),
          incompleteSearch: body.incompleteSearch === true,
        };
      });
    });
  }

  async getFile(input: { installationId: string; fileId: string }): Promise<GoogleDriveFile> {
    validateInstallationId(input.installationId);
    if (!input.fileId || input.fileId.length > 256 || /[\r\n]/.test(input.fileId)) {
      throw new GoogleDriveReadOnlyError('Invalid Google Drive file ID', 'INVALID_RESPONSE', 400);
    }
    return this.deps.connectors.execute(input.installationId, async () => {
      await this.assertReadOnlyScope(input.installationId);
      const accessToken = await this.deps.tokenLifecycle.getAccessToken(input.installationId);
      const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(input.fileId)}`);
      url.searchParams.set('fields', METADATA_FIELDS);
      return this.request<GoogleDriveFile>(url, accessToken, safeFile);
    });
  }

  private async assertReadOnlyScope(installationId: string): Promise<void> {
    await this.deps.vault.withCredentials(installationId, async (credentials) => {
      const scopes = Array.isArray(credentials.scopes) ? credentials.scopes : [];
      if (!scopes.includes(DRIVE_METADATA_SCOPE)) {
        throw new GoogleDriveReadOnlyError(
          'Reconnect Google Workspace and grant Drive metadata read-only access',
          'INSUFFICIENT_SCOPE',
          403,
        );
      }
    });
  }

  private async request<TResult>(
    url: URL,
    accessToken: string,
    parse: (body: GoogleDriveResponse) => TResult,
  ): Promise<TResult> {
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleDriveReadOnlyError('Google Drive is temporarily unavailable', 'PROVIDER_UNAVAILABLE', 503);
    }
    if (response.status === 404) {
      throw new GoogleDriveReadOnlyError('Google Drive file is unavailable', 'NOT_FOUND', 404);
    }
    if (!response.ok) {
      throw new GoogleDriveReadOnlyError(
        response.status === 403 ? 'Google Drive denied this read request' : 'Google Drive request failed',
        response.status === 403 ? 'INSUFFICIENT_SCOPE' : 'PROVIDER_UNAVAILABLE',
        response.status === 403 ? 403 : 502,
      );
    }
    let body: GoogleDriveResponse;
    try {
      body = (await response.json()) as GoogleDriveResponse;
    } catch {
      throw new GoogleDriveReadOnlyError('Google Drive returned an invalid response', 'INVALID_RESPONSE', 502);
    }
    return parse(body);
  }
}
