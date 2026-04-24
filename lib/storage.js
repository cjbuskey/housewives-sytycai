const { Storage } = require('@google-cloud/storage');

let storageClient;

function getStorage() {
  if (storageClient) return storageClient;

  const options = {};
  if (process.env.GOOGLE_CLOUD_CREDENTIALS) {
    try {
      options.credentials = JSON.parse(process.env.GOOGLE_CLOUD_CREDENTIALS);
    } catch {
      throw new Error(
        'GOOGLE_CLOUD_CREDENTIALS is set but is not valid JSON. ' +
          'Either fix the value or unset it and use GOOGLE_APPLICATION_CREDENTIALS (file path) instead.'
      );
    }
  }
  if (process.env.GOOGLE_CLOUD_PROJECT_ID) {
    options.projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  }

  storageClient = new Storage(options);
  return storageClient;
}

module.exports = { getStorage };
