require('module-alias/register');
const mongoose = require('mongoose');
const { createModels, createMethods, runAsSystem } = require('@librechat/data-schemas');
const { runGoogleWorkspaceRevocationDeadLetterCommand } = require('@librechat/api');

createModels(mongoose);
const methods = createMethods(mongoose);

runGoogleWorkspaceRevocationDeadLetterCommand(process.argv.slice(2), {
  connect: () => require('./db/connect').connectDb(),
  disconnect: () => mongoose.disconnect(),
  runAsSystem,
  store: {
    listGoogleWorkspaceRevocationDeadLetters: (input) =>
      methods.listGoogleWorkspaceRevocationDeadLetters(input),
    requeueGoogleWorkspaceRevocationDeadLetter: (input) =>
      methods.requeueGoogleWorkspaceRevocationDeadLetter(input),
  },
  write: console.log,
  writeError: console.error,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Google Workspace revocation operation failed');
    process.exitCode = 1;
  });
