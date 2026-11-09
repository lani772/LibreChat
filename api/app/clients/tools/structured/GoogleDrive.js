const { Tool } = require('@librechat/agents/langchain/tools');
const { getUserId } = require('@librechat/data-schemas');
const db = require('~/models');
const { getGoogleDriveReadOnlyConnector } = require('~/server/services/initializeMCPs');

const schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['search_files', 'get_file_metadata'],
      description: 'Search Drive files or retrieve metadata for one file.',
    },
    query: {
      type: 'string',
      description: 'Google Drive search expression, for example name contains \'budget\'. Use Drive query syntax.',
    },
    fileId: {
      type: 'string',
      description: 'Google Drive file ID; required for get_file_metadata.',
    },
    installationId: {
      type: 'string',
      description: 'Optional owned Google Workspace connection ID. If omitted, the only connected account is selected automatically; if several exist, the tool returns safe account choices.',
    },
    pageSize: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Maximum metadata records to return. Defaults to 25.',
    },
    pageToken: {
      type: 'string',
      description: 'Opaque nextPageToken returned by a previous search.',
    },
  },
  required: ['action'],
};

class GoogleDrive extends Tool {
  static lc_name() {
    return 'google_drive';
  }

  static get jsonSchema() {
    return schema;
  }

  constructor(fields = {}) {
    super(fields);
    this.name = 'google_drive';
    this.description =
      'Search the authenticated user’s Google Drive or retrieve file metadata. This tool is read-only: it cannot download, edit, upload, export, or delete file contents.';
    this.schema = schema;
  }

  async resolveInstallation(installationId) {
    const principalId = getUserId();
    if (!principalId) {
      throw new Error('Google Workspace identity is unavailable');
    }
    if (installationId) {
      // The provider connector performs the definitive tenant/owner/grant check.
      return installationId;
    }
    const installations = await db.listConnectorInstallations({
      ownerUserId: principalId,
      provider: 'google-workspace',
      state: 'connected',
      limit: 50,
    });
    if (installations.length === 0) {
      return { error: 'No connected Google Workspace account was found. Connect one in the MCP Servers panel.' };
    }
    if (installations.length > 1) {
      return {
        error: 'Choose which connected Google Workspace account to use by passing its installationId.',
        accounts: installations.map((item) => ({
          installationId: item._id.toString(),
          displayName: item.displayName,
        })),
      };
    }
    return installations[0]._id.toString();
  }

  async _call(input) {
    try {
      const installation = await this.resolveInstallation(input.installationId);
      if (typeof installation !== 'string') return JSON.stringify(installation);
      const drive = getGoogleDriveReadOnlyConnector();
      if (!drive) return 'Google Drive is not configured on this server.';
      if (input.action === 'search_files') {
        const result = await drive.listFiles({
          installationId: installation,
          ...(typeof input.query === 'string' ? { query: input.query } : {}),
          ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
          ...(typeof input.pageToken === 'string' ? { pageToken: input.pageToken } : {}),
        });
        return JSON.stringify(result);
      }
      if (input.action === 'get_file_metadata') {
        if (typeof input.fileId !== 'string' || !input.fileId.trim()) {
          return 'fileId is required for get_file_metadata.';
        }
        return JSON.stringify(await drive.getFile({
          installationId: installation,
          fileId: input.fileId,
        }));
      }
      return 'Unsupported Google Drive action.';
    } catch (error) {
      // Never forward provider response bodies, credentials, or stack traces to the model.
      if (error?.statusCode === 403) return 'Google Drive read access is not granted. Reconnect the account and approve the Drive metadata read-only permission.';
      if (error?.statusCode === 404) return 'The Google Workspace connection or file is unavailable.';
      return 'Google Drive could not complete this read-only request. Check the connection and try again.';
    }
  }
}

module.exports = GoogleDrive;
