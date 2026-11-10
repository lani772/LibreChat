require('module-alias/register');
const mongoose = require('mongoose');
const { createModels, createMethods, runAsSystem } = require('@librechat/data-schemas');
const { runConnectorCredentialRotationCommand } = require('@librechat/api');

createModels(mongoose);
const methods = createMethods(mongoose);

runConnectorCredentialRotationCommand(process.argv.slice(2), {
  connect: () => require('./db/connect').connectDb(),
  disconnect: () => mongoose.disconnect(),
  runAsSystem,
  store: {
    listConnectorCredentialsForRotation: (input) =>
      methods.listConnectorCredentialsForRotation(input),
    replaceConnectorCredentialForRotation: (input) =>
      methods.replaceConnectorCredentialForRotation(input),
  },
  write: console.log,
  writeError: console.error,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Connector credential rotation failed');
    process.exitCode = 1;
  });
